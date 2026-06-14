let audioHtml = document.createElement('audio'); 
let hlsPlayer = null; // Переменная под HLS плеер
let audioPlayPromise = null; // Промис для отслеживания состояния воспроизведения

let currentPlaylist = [];
let currentTrackIndex = -1;
let isPlaying = false;

// Хранилища для разделения результатов по вкладкам, чтобы они не перемешивалось на экране
let wavePlaylist = [];
let searchPlaylist = [];
let favoritesPlaylist = [];

const BACKEND_URL = window.location.origin;

// Элементы UI
const tabWaveBtn = document.getElementById('tab-wave-btn');
const tabSearchBtn = document.getElementById('tab-search-btn');
const tabFavBtn = document.getElementById('tab-favorites-btn');

const wavePanel = document.getElementById('wave-panel');
const searchPanel = document.getElementById('search-panel');
const favoritesPanel = document.getElementById('favorites-panel');

const startWaveBtn = document.getElementById('start-wave-btn');
const waveGenre = document.getElementById('wave-genre');
const waveVibe = document.getElementById('wave-vibe');
const searchInput = document.getElementById('search-input');
const searchBtn = document.getElementById('search-btn');
const tracksGrid = document.querySelector('.tracks-grid');
const playerBar = document.querySelector('.bottom-player-bar');
const playPauseBtn = document.getElementById('custom-play-pause');
const prevBtn = document.getElementById('custom-prev');
const nextBtn = document.getElementById('custom-next');
const playerHeartBtn = document.getElementById('custom-heart-btn'); // Кнопка лайка в плеере
const trackTitle = document.querySelector('.now-playing-title');
const trackArtist = document.querySelector('.now-playing-artist');
const trackCover = document.querySelector('.now-playing-album-art');
const timeline = document.getElementById('custom-timeline');
const progressFill = document.getElementById('custom-progress-fill');
const timelineThumb = document.getElementById('custom-timeline-thumb');
const currentTimeEl = document.getElementById('current-time');
const durationTimeEl = document.getElementById('duration-time');
const volumeSlider = document.getElementById('volume-slider');

// Контекст текущего играющего списка (чтобы понимать, откуда переключать треки кнопками "Вперед/Назад")
let currentPlaylistContext = 'wave'; 

// Умное переключение вкладок с изоляцией контента
function switchTab(activeBtn, activePanel) {
    [tabWaveBtn, tabSearchBtn, tabFavBtn].forEach(btn => { if(btn) btn.classList.remove('active') });
    [wavePanel, searchPanel, favoritesPanel].forEach(panel => { if(panel) panel.classList.remove('active') });
    
    if(activeBtn) activeBtn.classList.add('active');
    if(activePanel) activePanel.classList.add('active');

    // Очищаем или подгружаем корректные треки для выбранной вкладки
    if (activePanel === wavePanel) {
        renderTracks(wavePlaylist);
    } else if (activePanel === searchPanel) {
        renderTracks(searchPlaylist);
    }
}

if (tabWaveBtn) tabWaveBtn.addEventListener('click', () => switchTab(tabWaveBtn, wavePanel));
if (tabSearchBtn) tabSearchBtn.addEventListener('click', () => switchTab(tabSearchBtn, searchPanel));

if (tabFavBtn) {
    tabFavBtn.addEventListener('click', async () => {
        switchTab(tabFavBtn, favoritesPanel);
        try {
            const res = await fetch(`${BACKEND_URL}/api/get-favorites`);
            if (res.status === 401) {
                window.location.href = '/login_page';
                return;
            }
            const data = await res.json();
            if (data.status === 'success') {
                favoritesPlaylist = data.tracks;
                // Загружаем в плеер актуальный плейлист, если трек играет из медиатеки
                if (currentPlaylistContext === 'favorites') {
                    currentPlaylist = favoritesPlaylist;
                }
                renderTracks(favoritesPlaylist);
            }
        } catch (err) {
            console.error("Ошибка получения избранного:", err);
        }
    });
}

// Универсальная функция лайка (работает и для карточек, и для нижнего плеера)
async function toggleFavorite(track, index, event, currentRenderedList) {
    if (event) event.stopPropagation();
    try {
        const response = await fetch(`${BACKEND_URL}/api/add-favorite`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(track)
        });
        if (response.status === 401) {
            window.location.href = '/login_page';
            return;
        }
        if (response.ok) {
            const data = await response.json();
            const isFavNow = (data.action === 'added');
            
            track.is_favorite = isFavNow;
            
            // Синхронизируем состояние лайка во всех локальных списках
            [wavePlaylist, searchPlaylist, favoritesPlaylist, currentPlaylist].forEach(list => {
                const found = list.find(t => t.stream_node_url === track.stream_node_url);
                if (found) found.is_favorite = isFavNow;
            });

            // Переключаем класс активности у сердечка в плеере, если этот трек сейчас играет
            if (currentPlaylist[currentTrackIndex] && currentPlaylist[currentTrackIndex].stream_node_url === track.stream_node_url) {
                if (playerHeartBtn) {
                    playerHeartBtn.classList.toggle('is-fav-active', isFavNow);
                }
            }

            // Если убрали лайк, находясь внутри вкладки "Медиатека", удаляем трек из отображения
            if (data.action === 'removed' && tabFavBtn && tabFavBtn.classList.contains('active')) {
                const favIndex = favoritesPlaylist.findIndex(t => t.stream_node_url === track.stream_node_url);
                if (favIndex !== -1) favoritesPlaylist.splice(favIndex, 1);
                renderTracks(favoritesPlaylist);
            } else {
                if (currentRenderedList) {
                    renderTracks(currentRenderedList);
                } else {
                    // Если лайкнули из плеера, обновляем текущую видимую вкладку
                    if (tabWaveBtn && tabWaveBtn.classList.contains('active')) renderTracks(wavePlaylist);
                    else if (tabSearchBtn && tabSearchBtn.classList.contains('active')) renderTracks(searchPlaylist);
                    else if (tabFavBtn && tabFavBtn.classList.contains('active')) renderTracks(favoritesPlaylist);
                }
            }
        }
    } catch (err) {
        console.error(err);
    }
}

// Слушатель для кнопки лайка в плеере
if (playerHeartBtn) {
    playerHeartBtn.addEventListener('click', (e) => {
        if (currentTrackIndex !== -1 && currentPlaylist[currentTrackIndex]) {
            const playingTrack = currentPlaylist[currentTrackIndex];
            toggleFavorite(playingTrack, currentTrackIndex, e, null);
        }
    });
}

// Волна (Миксер)
async function generateWave() {
    if(!startWaveBtn) return;
    startWaveBtn.disabled = true; startWaveBtn.textContent = 'Настраиваю вайб...';
    try {
        const response = await fetch(`${BACKEND_URL}/api/wave`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ genre: waveGenre.value, vibe: waveVibe.value })
        });
        const data = await response.json();
        if (data.status === 'success' && data.tracks.length > 0) {
            wavePlaylist = data.tracks;
            currentPlaylist = wavePlaylist;
            currentPlaylistContext = 'wave';
            renderTracks(wavePlaylist); 
            playTrack(0);
        } else { alert('Не удалось собрать Волну.'); }
    } catch (err) { console.error(err); }
    finally { startWaveBtn.disabled = false; startWaveBtn.textContent = 'Запустить'; }
}
if(startWaveBtn) startWaveBtn.addEventListener('click', generateWave);

// Поиск
async function performSearch() {
    const query = searchInput.value.trim();
    if (!query || !searchBtn) return;
    searchBtn.disabled = true; searchBtn.textContent = 'Ищу...';
    try {
        const response = await fetch(`${BACKEND_URL}/api/search`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ query: query })
        });
        const data = await response.json();
        if (data.status === 'success' && data.tracks) {
            searchPlaylist = data.tracks;
            currentPlaylist = searchPlaylist;
            currentPlaylistContext = 'search';
            renderTracks(searchPlaylist);
        } else { alert('Ничего не найдено.'); }
    } catch (err) { console.error(err); }
    finally { searchBtn.disabled = false; searchBtn.textContent = 'Искать'; }
}
if(searchBtn) searchBtn.addEventListener('click', performSearch);
if(searchInput) searchInput.addEventListener('keypress', (e) => { if (e.key === 'Enter') performSearch(); });

// Отрисовка карточек треков с использованием векторных SVG-сердечек
function renderTracks(tracks) {
    if(!tracksGrid) return;
    tracksGrid.innerHTML = ''; 
    
    if (tracks.length === 0 && tabFavBtn && tabFavBtn.classList.contains('active')) {
        tracksGrid.innerHTML = `<div style="grid-column: 1/-1; text-align: center; color: #626875; margin-top: 40px;">Медиатека пуста.</div>`;
        return;
    }
    if (tracks.length === 0) return;

    tracks.forEach((track, index) => {
        const card = document.createElement('div');
        card.className = 'track-card';
        
        // Подсвечиваем рамку карточки, если этот трек сейчас играет в плеере
        if (currentPlaylist[currentTrackIndex] && currentPlaylist[currentTrackIndex].stream_node_url === track.stream_node_url) {
            card.classList.add('active-playing');
        }
        
        const coverUrl = track.cover_art_url.startsWith('http') ? track.cover_art_url : `${BACKEND_URL}${track.cover_art_url}`;
        
        // Выставляем класс активности на основе статуса лайка трека
        const favClass = track.is_favorite ? 'is-fav-active' : '';

        card.innerHTML = `
            <div class="track-cover" style="background-image: url('${coverUrl}')">
                <div class="play-overlay">▶</div>
                <button class="card-heart-trigger ${favClass}">
                    <svg class="heart-icon-svg" viewBox="0 0 24 24">
                        <path d="M12 21.35l-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.54L12 21.35z"/>
                    </svg>
                </button>
            </div>
            <div class="track-info">
                <h4 class="track-title" title="${track.name}">${track.name}</h4>
                <p class="track-artist" title="${track.artist}">${track.artist}</p>
            </div>
        `;
        
        const heartBtn = card.querySelector('.card-heart-trigger');
        heartBtn.addEventListener('click', (e) => toggleFavorite(track, index, e, tracks));

        card.addEventListener('click', (e) => {
            if (e.target.closest('.card-heart-trigger')) return; // Корректно игнорируем клик по SVG
            
            // Перед воспроизведением переключаем глобальный плейлист на тот список, куда кликнули
            if (tabWaveBtn && tabWaveBtn.classList.contains('active')) {
                currentPlaylist = wavePlaylist;
                currentPlaylistContext = 'wave';
            } else if (tabSearchBtn && tabSearchBtn.classList.contains('active')) {
                currentPlaylist = searchPlaylist;
                currentPlaylistContext = 'search';
            } else if (tabFavBtn && tabFavBtn.classList.contains('active')) {
                currentPlaylist = favoritesPlaylist;
                currentPlaylistContext = 'favorites';
            }
            
            playTrack(index);
        });
        
        tracksGrid.appendChild(card);
    });
}

// Воспроизведение
async function safePlay() {
    try {
        audioPlayPromise = audioHtml.play();
        if (audioPlayPromise !== null) {
            await audioPlayPromise; setPlayState(true); audioPlayPromise = null;
        }
    } catch (err) {
        setPlayState(false); audioPlayPromise = null;
    }
}

async function playTrack(index) {
    if (index < 0 || index >= currentPlaylist.length) return;
    currentTrackIndex = index;
    const track = currentPlaylist[index];

    if(trackTitle) trackTitle.textContent = track.name;
    if(trackArtist) trackArtist.textContent = track.artist;
    if(trackCover) trackCover.src = track.cover_art_url.startsWith('http') ? track.cover_art_url : `${BACKEND_URL}${track.cover_art_url}`;
    
    // При старте нового трека синхронизируем класс активности нижнего плеера
    if (playerHeartBtn) {
        playerHeartBtn.classList.toggle('is-fav-active', !!track.is_favorite);
    }

    // Обновляем зеленую рамку активного трека на текущей вкладке
    if (tabWaveBtn && tabWaveBtn.classList.contains('active')) renderTracks(wavePlaylist);
    else if (tabSearchBtn && tabSearchBtn.classList.contains('active')) renderTracks(searchPlaylist);
    else if (tabFavBtn && tabFavBtn.classList.contains('active')) renderTracks(favoritesPlaylist);

    if(playerBar) playerBar.classList.add('visible');

    try {
        if (audioPlayPromise !== null) { try { await audioPlayPromise; } catch(e) {} }
        audioHtml.pause();
        if (hlsPlayer) { hlsPlayer.destroy(); hlsPlayer = null; }
        audioHtml.removeAttribute('src'); audioHtml.load();

        const streamResponse = await fetch(`${BACKEND_URL}/api/stream?url=${encodeURIComponent(track.stream_node_url)}`);
        const streamData = await streamResponse.json();
        
        if (streamData.status === 'success' && streamData.url) {
            let finalAudioUrl = streamData.url;
            if (!finalAudioUrl.startsWith('http')) finalAudioUrl = `${BACKEND_URL}${finalAudioUrl}`;
            
            if (streamData.type === "hls") {
                if (window.Hls && Hls.isSupported()) {
                    hlsPlayer = new Hls();
                    hlsPlayer.loadSource(finalAudioUrl); hlsPlayer.attachMedia(audioHtml);
                    hlsPlayer.on(Hls.Events.MANIFEST_PARSED, () => safePlay());
                }
            } else {
                audioHtml.src = finalAudioUrl; audioHtml.load(); safePlay();
            }
        } else { nextTrack(); }
    } catch (error) { nextTrack(); }
}

function setPlayState(playing) {
    isPlaying = playing;
    if(playPauseBtn) playPauseBtn.textContent = isPlaying ? '⏸' : '▶';
}

if(playPauseBtn) {
    playPauseBtn.addEventListener('click', async () => {
        if (!audioHtml.src && !hlsPlayer) return;
        if (isPlaying) { audioHtml.pause(); setPlayState(false); } else { safePlay(); }
    });
}

function nextTrack() {
    if (currentTrackIndex < currentPlaylist.length - 1) playTrack(currentTrackIndex + 1);
    else setPlayState(false);
}

if(prevBtn) prevBtn.addEventListener('click', () => { if (currentTrackIndex > 0) playTrack(currentTrackIndex - 1); });
if(nextBtn) nextBtn.addEventListener('click', nextTrack);
audioHtml.addEventListener('ended', nextTrack);

// Перемотка (Timeline)
let isDraggingTimeline = false; 
function updateTimelineOnMove(clientX) {
    if(!timeline) return 0;
    const rect = timeline.getBoundingClientRect();
    const percentage = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
    if(progressFill) progressFill.style.width = `${percentage * 100}%`;
    if(timelineThumb) timelineThumb.style.left = `${percentage * 100}%`;
    return percentage;
}

audioHtml.addEventListener('timeupdate', () => {
    if (isDraggingTimeline) return;
    const current = audioHtml.currentTime;
    const duration = audioHtml.duration || 0;
    if(currentTimeEl) currentTimeEl.textContent = formatTime(current);
    if(durationTimeEl) durationTimeEl.textContent = formatTime(duration);
    if (duration > 0) {
        const percentage = (current / duration) * 100;
        if(progressFill) progressFill.style.width = `${percentage}%`;
        if(timelineThumb) timelineThumb.style.left = `${percentage}%`;
    }
});

if(timeline) {
    timeline.addEventListener('mousedown', (e) => {
        if ((audioHtml.duration || 0) === 0) return;
        isDraggingTimeline = true; updateTimelineOnMove(e.clientX);
    });
}
window.addEventListener('mousemove', (e) => { if (isDraggingTimeline) updateTimelineOnMove(e.clientX); });
window.addEventListener('mouseup', (e) => {
    if (!isDraggingTimeline) return;
    isDraggingTimeline = false;
    const duration = audioHtml.duration || 0;
    if (duration > 0) audioHtml.currentTime = updateTimelineOnMove(e.clientX) * duration;
});

function formatTime(s) {
    if (isNaN(s)) return '0:00';
    return `${Math.floor(s / 60)}:${Math.floor(s % 60).toString().padStart(2, '0')}`;
}

if(volumeSlider) { volumeSlider.addEventListener('input', (e) => { audioHtml.volume = e.target.value; }); }

// Проверка сессии (Профиль)
document.addEventListener('DOMContentLoaded', () => {
    const authZone = document.getElementById('auth-zone');
    if (!authZone) return;
    
    const savedUsername = localStorage.getItem('username');
    if (savedUsername) {
        if (tabFavBtn) tabFavBtn.style.display = 'block';
        authZone.innerHTML = `
            <span style="color: #00ff87; font-weight: 600;">👤 ${savedUsername}</span>
            <a href="/logout" id="logout-btn" style="margin-left: 15px; color: #8c92a0; text-decoration: none; font-size: 13px;">Выйти</a>
        `;
        document.getElementById('logout-btn').addEventListener('click', () => localStorage.removeItem('username'));
    } else {
        if (tabFavBtn) tabFavBtn.style.display = 'none';
        authZone.innerHTML = `<a href="/login_page" style="color: #00ff87; text-decoration: none; font-weight: 600;">Войти</a>`;
    }
});