# ============================================================
#  app.py v3 — Flask + SocketIO + SQLite
#
#  Handles two packet types from ADXL345 receiver:
#    STAT  — periodic stats (every 10s):
#              Min/Max/Avg Roll/Pitch + Avg Accel X/Y/Z
#    EVENT — shock alert (total accel > threshold)
#
#  Note: ADXL345 has no magnetometer → no Yaw, no temperature.
#
#  Install:
#    pip install flask flask-socketio eventlet pyserial
#
#  Run:
#    python app.py
#  Open:
#    http://localhost:5000
# ============================================================

import threading
import sqlite3
import serial
import serial.tools.list_ports
from datetime import datetime
from flask import Flask, render_template, jsonify
from flask_socketio import SocketIO

# ── Config ────────────────────────────────────────────────────
SERIAL_PORT = "COM6"
SERIAL_BAUD = 115200
DB_FILE     = "imu_data.db"

# ── Flask + SocketIO ──────────────────────────────────────────
app = Flask(__name__)
app.config["SECRET_KEY"] = "imu-v3"
socketio = SocketIO(app, cors_allowed_origins="*", async_mode="threading")

# ── SQLite setup ──────────────────────────────────────────────
def init_db():
    conn = sqlite3.connect(DB_FILE)
    c = conn.cursor()

    # Periodic statistics table
    # ADXL345: Roll + Pitch (computed), plus accel averages; no Yaw, no temp
    c.execute("""
        CREATE TABLE IF NOT EXISTS stats (
            id           INTEGER PRIMARY KEY AUTOINCREMENT,
            timestamp    TEXT,
            roll_min     REAL, roll_max  REAL, roll_avg  REAL,
            pitch_min    REAL, pitch_max REAL, pitch_avg REAL,
            ax_avg       REAL, ay_avg    REAL, az_avg    REAL,
            sample_count INTEGER,
            rssi         INTEGER, snr REAL
        )
    """)

    # Shock event table
    # No Yaw, no temp
    c.execute("""
        CREATE TABLE IF NOT EXISTS events (
            id        INTEGER PRIMARY KEY AUTOINCREMENT,
            timestamp TEXT,
            acc_x     REAL, acc_y REAL, acc_z REAL,
            roll      REAL, pitch REAL,
            rssi      INTEGER, snr REAL
        )
    """)

    conn.commit()
    conn.close()
    print(f"[DB] SQLite initialized — {DB_FILE}")

# ── Extract value from CSV key:val string ─────────────────────
def extract(payload, key):
    try:
        search = key + ":"
        idx = payload.index(search) + len(search)
        end = payload.find(",", idx)
        val = payload[idx:] if end == -1 else payload[idx:end]
        return float(val.strip())
    except:
        return None

# ── Parse and store STAT packet ───────────────────────────────
def handle_stat(payload, rssi, snr):
    ts = datetime.now().strftime("%Y-%m-%d %H:%M:%S")

    data = {
        "type":      "STAT",
        "timestamp": ts,
        "roll_min":  extract(payload, "RMin"),
        "roll_max":  extract(payload, "RMax"),
        "roll_avg":  extract(payload, "RAvg"),
        "pitch_min": extract(payload, "PMin"),
        "pitch_max": extract(payload, "PMax"),
        "pitch_avg": extract(payload, "PAvg"),
        "ax_avg":    extract(payload, "AXAvg"),
        "ay_avg":    extract(payload, "AYAvg"),
        "az_avg":    extract(payload, "AZAvg"),
        "count":     extract(payload, "CNT"),
        "rssi":      rssi,
        "snr":       snr,
    }

    conn = sqlite3.connect(DB_FILE)
    conn.execute("""
        INSERT INTO stats (timestamp,
            roll_min, roll_max, roll_avg,
            pitch_min, pitch_max, pitch_avg,
            ax_avg, ay_avg, az_avg,
            sample_count, rssi, snr)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
    """, (ts,
          data["roll_min"],  data["roll_max"],  data["roll_avg"],
          data["pitch_min"], data["pitch_max"], data["pitch_avg"],
          data["ax_avg"], data["ay_avg"], data["az_avg"],
          data["count"], rssi, snr))
    conn.commit()
    conn.close()

    socketio.emit("stat", data)
    print(f"[STAT] saved — Roll avg:{data['roll_avg']}  Pitch avg:{data['pitch_avg']}  Az avg:{data['az_avg']}")

# ── Parse and store EVENT packet ──────────────────────────────
def handle_event(payload, rssi, snr):
    ts = datetime.now().strftime("%Y-%m-%d %H:%M:%S")

    data = {
        "type":      "EVENT",
        "timestamp": ts,
        "acc_x":     extract(payload, "AX"),
        "acc_y":     extract(payload, "AY"),
        "acc_z":     extract(payload, "AZ"),
        "roll":      extract(payload, "R"),
        "pitch":     extract(payload, "P"),
        "rssi":      rssi,
        "snr":       snr,
    }

    conn = sqlite3.connect(DB_FILE)
    conn.execute("""
        INSERT INTO events (timestamp, acc_x, acc_y, acc_z,
            roll, pitch, rssi, snr)
        VALUES (?,?,?,?,?,?,?,?)
    """, (ts, data["acc_x"], data["acc_y"], data["acc_z"],
          data["roll"], data["pitch"], rssi, snr))
    conn.commit()
    conn.close()

    socketio.emit("event", data)
    print(f"[EVENT] SHOCK saved — AX:{data['acc_x']} AY:{data['acc_y']} AZ:{data['acc_z']}")

# ── Parse raw serial line ─────────────────────────────────────
def parse_line(raw):
    if "Recv:" not in raw:
        return

    payload = raw.split("Recv:", 1)[1]

    rssi = int(extract(payload, "RSSI") or 0)
    snr  = extract(payload, "SNR") or 0.0

    if "TYPE:STAT" in payload:
        handle_stat(payload, rssi, snr)
    elif "TYPE:EVENT" in payload:
        handle_event(payload, rssi, snr)

# ── Serial thread ─────────────────────────────────────────────
def serial_thread():
    print(f"[*] Opening {SERIAL_PORT} at {SERIAL_BAUD} baud...")
    while True:
        try:
            ser = serial.Serial(SERIAL_PORT, SERIAL_BAUD, timeout=1)
            print(f"[OK] Serial open")
            while True:
                raw = ser.readline().decode("utf-8", errors="ignore").strip()
                if raw:
                    print(f"[RAW] {raw}")
                    parse_line(raw)
        except serial.SerialException as e:
            print(f"[Serial error] {e} — retrying...")
            import time; time.sleep(2)

# ── REST API — last 50 stats ──────────────────────────────────
@app.route("/api/stats")
def api_stats():
    conn = sqlite3.connect(DB_FILE)
    conn.row_factory = sqlite3.Row
    rows = conn.execute(
        "SELECT * FROM stats ORDER BY id DESC LIMIT 50"
    ).fetchall()
    conn.close()
    return jsonify([dict(r) for r in rows])

# ── REST API — last 50 events ─────────────────────────────────
@app.route("/api/events")
def api_events():
    conn = sqlite3.connect(DB_FILE)
    conn.row_factory = sqlite3.Row
    rows = conn.execute(
        "SELECT * FROM events ORDER BY id DESC LIMIT 50"
    ).fetchall()
    conn.close()
    return jsonify([dict(r) for r in rows])

# ── Frontend ──────────────────────────────────────────────────
@app.route("/")
def index():
    return render_template("index.html")

# ── Main ──────────────────────────────────────────────────────
if __name__ == "__main__":
    init_db()

    print("=" * 50)
    print("  IMU Dashboard v3 — ADXL345 · Flask + SQLite")
    print("=" * 50)
    print(f"  Serial : {SERIAL_PORT} @ {SERIAL_BAUD}")
    print(f"  DB     : {DB_FILE}")
    print(f"  Open   : http://localhost:5000")
    print("=" * 50)

    ports = serial.tools.list_ports.comports()
    if ports:
        print("\n  Available COM ports:")
        for p in ports:
            print(f"    {p.device}  —  {p.description}")
    print()

    t = threading.Thread(target=serial_thread, daemon=True)
    t.start()

    socketio.run(app, host="0.0.0.0", port=5000, debug=False)
