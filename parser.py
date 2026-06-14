import os
import random
import requests
import urllib.parse
from datetime import datetime
import sqlite3
from flask import Flask, request, jsonify, render_template, Response, stream_with_context, session, redirect, url_for
from flask_cors import CORS
from werkzeug.security import generate_password_hash, check_password_hash

app = Flask(__name__, static_folder='static', template_folder='templates')
app.secret_key = 'super_secret_key_change_me_to_something_complex'
CORS(app)

CLIENT_ID = "mQqpsaUSNZxyik7mV9y4D6dunaNX3mrQ&stage"

# --- Инициализация Базы Данных ---
def init_db():
    conn = sqlite3.connect('music_app.db')
    cursor = conn.cursor()
    cursor.execute('''CREATE TABLE IF NOT EXISTS users 
                      (id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT UNIQUE, password TEXT)''')
    cursor.execute('''CREATE TABLE IF NOT EXISTS favorites 
                      (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER, track_name TEXT, 
                       artist TEXT, stream_url TEXT, cover_url TEXT,
                       FOREIGN KEY(user_id) REFERENCES users(id))''')
    conn.commit()
    conn.close()

init_db()

# --- Вспомогательная функция для проверки лайков ---
def mark_favorites(tracks):
    user_id = session.get('user_id')
    if not user_id:
        for track in tracks:
            track['is_favorite'] = False
        return tracks

    conn = sqlite3.connect('music_app.db')
    cursor = conn.cursor()
    # Получаем все лайкнутые треки пользователя в виде множества кортежей для быстрого поиска
    fav_rows = cursor.execute("SELECT track_name, artist FROM favorites WHERE user_id = ?", (user_id,)).fetchall()
    conn.close()

    fav_set = {(row[0].lower().strip(), row[1].lower().strip()) for row in fav_rows}

    for track in tracks:
        track_key = (track['name'].lower().strip(), track['artist'].lower().strip())
        track['is_favorite'] = track_key in fav_set

    return tracks

# --- Роуты Визуальных Страниц (HTML) ---

@app.route('/')
def index():
    return render_template('index.html')

@app.route('/login_page')
def login_page():
    return render_template('login.html')

@app.route('/register_page')
def register_page():
    return render_template('register.html')


# --- Роуты Авторизации (Логика) ---

@app.route('/register', methods=['POST'])
def register():
    data = request.get_json()
    hashed_pw = generate_password_hash(data['password'])
    try:
        conn = sqlite3.connect('music_app.db')
        cursor = conn.cursor()
        cursor.execute("INSERT INTO users (username, password) VALUES (?, ?)", (data['username'], hashed_pw))
        conn.commit()
        conn.close()
        return jsonify({"status": "success"})
    except:
        return jsonify({"status": "error", "message": "Пользователь уже существует"}), 400

@app.route('/login', methods=['POST'])
def login():
    data = request.get_json()
    conn = sqlite3.connect('music_app.db')
    cursor = conn.cursor()
    user = cursor.execute("SELECT * FROM users WHERE username = ?", (data['username'],)).fetchone()
    conn.close()
    if user and check_password_hash(user[2], data['password']):
        session['user_id'] = user[0]
        return jsonify({"status": "success", "username": user[1]})
    return jsonify({"status": "error", "message": "Неверный логин или пароль"}), 401

@app.route('/logout')
def logout():
    session.pop('user_id', None)
    return redirect(url_for('index'))


# --- Роуты для Избранного (Медиатека) ---

@app.route('/api/add-favorite', methods=['POST'])
def add_favorite():
    user_id = session.get('user_id')
    if not user_id:
        return jsonify({"status": "error", "message": "Нужно войти в систему"}), 401
        
    track = request.get_json()
    conn = sqlite3.connect('music_app.db')
    cursor = conn.cursor()
    
    existing = cursor.execute("""
        SELECT id FROM favorites 
        WHERE user_id = ? AND track_name = ? AND artist = ?
    """, (user_id, track['name'], track['artist'])).fetchone()
    
    if existing:
        cursor.execute("DELETE FROM favorites WHERE id = ?", (existing[0],))
        conn.commit()
        conn.close()
        return jsonify({"status": "success", "action": "removed"})
    else:
        cursor.execute("""
            INSERT INTO favorites (user_id, track_name, artist, stream_url, cover_url) 
            VALUES (?, ?, ?, ?, ?)
        """, (user_id, track['name'], track['artist'], track['stream_node_url'], track['cover_art_url']))
        conn.commit()
        conn.close()
        return jsonify({"status": "success", "action": "added"})

@app.route('/api/get-favorites', methods=['GET'])
def get_favorites():
    user_id = session.get('user_id')
    if not user_id:
        return jsonify({"status": "error", "message": "Нужно войти в систему"}), 401
        
    conn = sqlite3.connect('music_app.db')
    conn.row_factory = sqlite3.Row 
    cursor = conn.cursor()
    
    rows = cursor.execute("""
        SELECT track_name as name, artist, stream_url as stream_node_url, cover_url as cover_art_url 
        FROM favorites WHERE user_id = ? ORDER BY id DESC
    """, (user_id,)).fetchall()
    
    conn.close()
    
    tracks = [dict(row) for row in rows]
    # Все треки из медиатеки априори являются лайкнутыми
    for track in tracks:
        track['is_favorite'] = True
        
    return jsonify({"status": "success", "tracks": tracks})


# --- Основной функционал поиска и стриминга ---

def get_soundcloud_tracks(search_query, limit=30):
    search_url = f"https://api-v2.soundcloud.com/search/tracks?q={search_query}&client_id={CLIENT_ID}&limit={limit}"
    headers = {"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36"}
    try:
        response = requests.get(search_url, headers=headers, timeout=6)
        if response.status_code != 200: return []
        data = response.json()
        playlist_data = []
        for track in data.get('collection', []):
            if track.get('kind') != 'track': continue
            media = track.get('media', {}).get('transcodings', [])
            
            stream_node_url = next((t.get('url') for t in media if t.get('format', {}).get('protocol') == 'hls'), None)
            if not stream_node_url:
                stream_node_url = next((t.get('url') for t in media if t.get('format', {}).get('protocol') == 'progressive'), None)
            if not stream_node_url: continue
            
            cover = track.get('artwork_url') or track.get('user', {}).get('avatar_url')
            if cover and "-large" in cover:
                cover = cover.replace("-large", "-t300x300")
                
            cover_url = f"/api/proxy-image?url={urllib.parse.quote_plus(cover)}" if cover else "/api/proxy-image?url=https%3A%2F%2Fimages.unsplash.com%2Fphoto-1614613535308-eb5fbd3d2c17"
            playlist_data.append({
                "name": track.get('title', 'Без названия'),
                "artist": track.get('user', {}).get('username', 'Неизвестный исполнитель'),
                "stream_node_url": stream_node_url, 
                "cover_art_url": cover_url,
                "date_added": datetime.now().strftime("%d.%m.%Y")
            })
        return playlist_data
    except Exception as e:
        print(f"Ошибка парсинга: {e}")
        return []

@app.route('/api/search', methods=['POST'])
def search():
    req_data = request.get_json() or {}
    query = req_data.get('query', 'phonk')
    playlist_data = get_soundcloud_tracks(query, limit=30)
    # Проверяем и маркируем лайкнутые треки перед отправкой
    playlist_data = mark_favorites(playlist_data)
    return jsonify({"status": "success", "tracks": playlist_data})

@app.route('/api/wave', methods=['POST'])
def wave():
    req_data = request.get_json() or {}
    genre = req_data.get('genre', 'all')
    vibe = req_data.get('vibe', 'all')
    
    search_pool = ['phonk', 'cyberpunk synthwave', 'nightcore', 'lofichill', 'gaming beat']
    if genre != 'all':
        mapping = {
            'phonk': ['drift phonk', 'memphis rap', 'house phonk'],
            'rust': ['raid music', 'hardstyle gaming', 'agressive phonk'],
            'lofi': ['lofi hip hop', 'chillhop', 'japanese lofi'],
            'synth': ['synthwave 80s', 'retrowave', 'outrun cyberpunk']
        }
        search_pool = mapping.get(genre, search_pool)

    if vibe != 'all':
        search_pool = [f"{vibe} {q}" for q in search_pool]
    
    selected_tags = random.sample(search_pool, min(2, len(search_pool)))
    raw_tracks = []
    for tag in selected_tags:
        raw_tracks.extend(get_soundcloud_tracks(tag, limit=10))
        
    random.shuffle(raw_tracks)
    # Проверяем и маркируем лайкнутые треки перед отправкой
    raw_tracks = mark_favorites(raw_tracks)
    return jsonify({"status": "success", "tracks": raw_tracks[:25]})

@app.route('/api/stream', methods=['GET'])
def stream():
    node_url = request.args.get('url')
    if not node_url: return jsonify({"status": "error", "message": "No url"}), 400
    try:
        headers = {"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36"}
        stream_resp = requests.get(f"{node_url}?client_id={CLIENT_ID}", headers=headers, timeout=5)
        if stream_resp.status_code == 200:
            real_audio_url = stream_resp.json().get('url')
            if real_audio_url:
                is_hls = "playlist.m3u8" in real_audio_url or "/hls" in node_url
                proxy_url = f"/api/proxy-hls?url={urllib.parse.quote_plus(real_audio_url)}" if is_hls else f"/api/proxy-audio?url={urllib.parse.quote_plus(real_audio_url)}"
                return jsonify({"status": "success", "url": proxy_url, "type": "hls" if is_hls else "mp3"})
        return jsonify({"status": "error", "message": "SoundCloud stream error"}), 400
    except Exception as e: 
        return jsonify({"status": "error", "message": str(e)}), 500

@app.route('/api/proxy-image', methods=['GET'])
def proxy_image():
    image_url = request.args.get('url')
    if not image_url: return "Missing URL", 400
    try:
        resp = requests.get(urllib.parse.unquote(image_url), timeout=5)
        return Response(resp.content, content_type=resp.headers.get('Content-Type', 'image/jpeg'))
    except: return "Error", 500

@app.route('/api/proxy-hls', methods=['GET'])
def proxy_hls():
    hls_url = request.args.get('url')
    if not hls_url: return "Missing URL", 400
    try:
        actual_hls_url = urllib.parse.unquote(hls_url)
        headers = {"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36", "Referer": "https://soundcloud.com/"}
        resp = requests.get(actual_hls_url, headers=headers, timeout=10)
        if resp.status_code != 200: return f"Error: {resp.status_code}", resp.status_code
        
        lines = resp.text.splitlines()
        base_url = actual_hls_url.rsplit('/', 1)[0] + '/'
        for i, line in enumerate(lines):
            line = line.strip()
            if line and not line.startswith('#'):
                full_segment_url = line if line.startswith('http') else base_url + line
                lines[i] = f"{request.scheme}://{request.host}/api/proxy-audio?url={urllib.parse.quote(full_segment_url, safe='')}"
        return Response("\n".join(lines), headers={"Content-Type": "application/x-mpegURL", "Access-Control-Allow-Origin": "*"})
    except Exception as e: return str(e), 500

@app.route('/api/proxy-audio', methods=['GET'])
def proxy_audio():
    audio_url = request.args.get('url')
    if not audio_url: return "Missing URL", 400
    try:
        actual_url = urllib.parse.unquote(audio_url)
        headers = {"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36", "Referer": "https://soundcloud.com/", "Range": request.headers.get('Range', 'bytes=0-')}
        req = requests.get(actual_url, headers=headers, stream=True, timeout=15)
        
        @stream_with_context
        def generate():
            for chunk in req.iter_content(chunk_size=65536):
                if chunk: yield chunk
        
        res_headers = {'Content-Type': req.headers.get('Content-Type', 'audio/mpeg'), 'Accept-Ranges': 'bytes', 'Access-Control-Allow-Origin': '*'}
        if 'Content-Length' in req.headers: res_headers['Content-Length'] = req.headers['Content-Length']
        return Response(generate(), headers=res_headers, status=req.status_code)
    except Exception as e: return str(e), 500

if __name__ == "__main__":
    app.run(host='0.0.0.0', port=5000, debug=True)