# Dub Choice — контекст проекта

Браузерная игра-переозвучка: клон режима **Dub Mode** из The Choicer Voicer
(Godot-игра от YeahMaybe), обратно совместимый с фанатскими dub-паками.
Свой дизайн и код, никаких ассетов оригинала. UI на русском и английском.

- Прод: **https://dubchoice.barinbo.im** (GitHub Pages + Actions, репо `barinboim/dub-choice`)
- Владелец: @barinboim (t.me/barinboimgpt)
- Референсы (скриншоты оригинала, файлы разработчика, фанатские паки) лежат
  в родительской папке `../` — она НЕ в git

## Геймплей (не ломать!)

1. Игрок выбирает dub-пак (встроенный из галереи или свой ZIP/папку)
2. Каждая реплика: видео+звук фрагмента → игрок записывает свой дубль,
   бирюзовая волна переписывает серую волну оригинала, курсор бежит
3. Дублей сколько угодно; **свои записи нельзя слушать до финала**
   (фишка оригинала; чекбокс «режим репетиции» это отключает)
4. Финал: ролик с озвучкой игрока. Пока он смотрит, **экспорт MP4 тихо идёт
   под капотом** — «Скачать» отдаёт готовый файл. Отдельно WAV-рендер аудио

## Формат dub-пака (совместимость)

```
_pack_info.ini              # [data] title, subtitle, icon, authors=[...]
dub_video.mp4|.webm|.ogv    # видео сцены; mp4/webm — наше расширение формата
_backing_track.wav|mp3|ogg  # опционально: фон без голосов
NN_name.ini|.txt            # [data] caption, dub_timestamps=[сек], dub_characters=[...], image=
NN_name.wav|mp3|ogg         # аудио оригинальной реплики
NN_name.png|jpg|webp        # кадр-превью
```

- ini в стиле Godot ConfigFile (`src/pack/ini.ts`); `.txt`-метаданные — так
  делают некоторые моды (Shrek); файлы без `dub_timestamps` — не реплики
- Приоритеты форматов: WAV→MP3→OGG, PNG→JPG→WEBP, MP4→WebM→OGV
- Реплики сортируются по `dub_timestamps[0]`; несколько таймстампов =
  запись вставляется несколько раз
- Паки без dub_video отклоняются с дружелюбной ошибкой (это Voice Packs)

## Архитектура (`src/`)

- `pack/` — `ini.ts` (парсер), `parser.ts` (сборка DubPack), `loader.ts`
  (ZIP через fflate / папка / drag-drop), `preloaded.ts` (галерея встроенных
  паков), `types.ts`
- `audio/` — `recorder.ts` (AudioWorklet → сырой PCM Float32),
  `waveform.ts` (канвас: пики, оверлей записи, курсор), `context.ts`
  (единый AudioContext + wasm-фолбэк OGG для Safari), `wav.ts`
- `video/player.ts` — единый интерфейс DubVideoPlayer: нативный `<video>`
  для mp4/webm, **ogv.js (wasm)** для Theora
- `game/` — `session.ts` (состояние сессии), `composer.ts` (финальный
  монтаж: mute-видео + backing + записи по таймстампам; скрытая запись
  MP4 через canvas.captureStream + MediaRecorder; WAV через OfflineAudioContext)
- `i18n.ts` — словарь ru/en, `data-i18n` для статики, `t()` для динамики
- `main.ts` — контроллер экранов (home → pack → dub → final)

## Грабли, на которые уже наступали

- **Theora мертва в браузерах**: Chrome/Firefox/Safari её удалили — .ogv
  играет только через ogv.js. 1080p Theora ogv.js НЕ тянет (слайдшоу),
  поэтому встроенные паки пережаты в H.264 480p mp4
- **Аудиотракт ogv.js ненадёжен** (Safari/Arc — тишина): звук реплик ведём
  сами через Web Audio из декодированного буфера, видео всегда muted
- **ogv.js**: свой AudioContext создаёт suspended → передаём наш
  (`{ audioContext }`); вставляет CSS `.ogvjsN{width:...px}` → наш CSS с
  `!important`; canvas кадров — `player._canvas`; ассеты копируются в
  `public/ogv` postinstall-скриптом
- **CDN GitHub (Fastly) бывает мучительно медленным** (10–50 КБ/с из РФ):
  паки качаются с raw.githubusercontent.com (CORS есть), но и он бывает
  медленным. Release-ассеты CORS НЕ отдают — не использовать
- **Лимит файла GitHub — 100 МБ**; больших файлов в репо не держать
- **Микрофон только на HTTPS** — по HTTP getUserMedia отсутствует
  (на этот случай есть отдельное сообщение об ошибке)
- **`[hidden]` перебивается `display:flex`** — в CSS есть
  `[hidden]{display:none!important}`
- Рамкам видео width задаётся явно: контент абсолютный, auto-маржины
  отключают grid-stretch → схлопывание

## Рабочие процессы

- Дев: `npm run dev`; прод-сборка: `npm run build` (tsc + vite)
- Тест парсера на реальных паках: `npm run test:packs -- "путь"`
- Смоук-тесты: Playwright-скрипты в scratchpad сессии (fake-микрофон:
  `--use-fake-device-for-media-stream`, mic-permission через grantPermissions)
- Деплой: push в main → Actions → Pages; кастомный домен уже настроен
- Пережатие видео пака: ffmpeg H.264 854×480 crf26 + aac 96k; кадры
  sips → jpg 854px (у homebrew-ffmpeg НЕТ libtheora)

## Планы

- Создание собственных dub-паков в приложении (редактор) — поэтому
  поддержаны современные кодеки в формате пака
- Ручной пайплайн сборки паков (demucs + whisper + ffmpeg) описан в
  `docs/DUBPACK_BUILD.md` — прототип будущего редактора
