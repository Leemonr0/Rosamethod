@echo off
chcp 65001 >nul
title Rose Method Pro - TikTok 1080p Quality Bypass
echo ===========================================================================
echo   ROSE METHOD PRO // 100%% ОБХОД СЖАТИЯ TIKTOK (1080p БЕЗ 576p / 1024p)
echo ===========================================================================
if "%~1"=="" (
    echo.
    echo [!] Просто перетащите ваш видеофайл MP4 или MOV мышкой прямо на этот файл!
    echo.
    pause
    exit /b
)

set "SRC_FILE=%~1"
set "STAGE1_TEMP=%~dp1temp_stage1_%RANDOM%.mp4"
set "FINAL_OUT=%~dp1IMG_%RANDOM%_rose_1080p.mp4"

echo [*] Входной файл: "%~nx1"
echo [*] Поиск FFmpeg...

python -c "import imageio_ffmpeg; open('temp_ffmpeg_path.txt', 'w').write(imageio_ffmpeg.get_ffmpeg_exe())" 2>nul
if exist temp_ffmpeg_path.txt (
    set /p FFMPEG_EXE=<temp_ffmpeg_path.txt
    del /f /q temp_ffmpeg_path.txt
) else (
    set "FFMPEG_EXE=ffmpeg"
)

echo [*] Используется FFmpeg: "%FFMPEG_EXE%"
echo.
echo ===========================================================================
echo  ВЫБЕРИТЕ ФОРМАТ ДЛЯ TIKTOK:
echo  [1] Вертикальный 9:16 (1080x1920) - Рекомендуется для рекомендаций TikTok
echo  [2] Оригинальный формат (16:9 1920x1080) - Без полос, горизонтально
echo ===========================================================================
choice /c 12 /t 5 /d 1 /m "Ваш выбор формата (через 5 сек автовыбор 1): "
set "ASPECT_CHOICE=%errorlevel%"

if "%ASPECT_CHOICE%"=="2" (
    echo [*] Режим: Горизонтальный 16:9 (1920x1080)...
    set "VF_FILTER=scale=1920:1080:force_original_aspect_ratio=decrease,format=yuv420p"
) else (
    echo [*] Режим: Вертикальный 9:16 (1080x1920)...
    set "VF_FILTER=scale=1080:1920:force_original_aspect_ratio=decrease,pad=1080:1920:(ow-iw)/2:(oh-ih)/2,format=yuv420p"
)

echo.
echo ===========================================================================
echo  ВЫБЕРИТЕ МЕТОД ОБХОДА TIKTOK:
echo  [1] Haze Max (Audio Ghost 10x + 0x0 Stsd - КАК В PULSE_HAZE) - РЕКОМЕНДУЕТСЯ
echo  [2] Rosa 2.0 (CompressBase Cloud API v1 Patch)
echo  [3] Rosa 1.0 (Local FastStart Ghost Sentinel 120 FPS) - 100%% ОФФЛАЙН
echo ===========================================================================
choice /c 123 /t 5 /d 1 /m "Ваш выбор метода (через 5 сек автовыбор 1): "
set "METHOD_CHOICE=%errorlevel%"

if "%METHOD_CHOICE%"=="3" (
    set "PATCH_MODE=ghost"
    echo [*] Выбран метод: Rosa 1.0 Local (FastStart Ghost 120 FPS)
) else if "%METHOD_CHOICE%"=="2" (
    set "PATCH_MODE=cb"
    echo [*] Выбран метод: Rosa 2.0 Pro (CompressBase Cloud API v1)
) else (
    set "PATCH_MODE=haze"
    echo [*] Выбран метод: Haze Max (Pulse Haze 0x0 Stsd + Audio Track 3)
)

echo [*] Нормализация профиля и таймкодов Core Media...
echo.

"%FFMPEG_EXE%" -nostdin -y -hide_banner -i "%SRC_FILE%" -map_metadata -1 -metadata make="Apple" -metadata model="iPhone 16 Pro" -metadata software="18.3.1" -metadata:s:v:0 handler_name="Core Media Video" -metadata:s:a:0 handler_name="Core Media Audio" -vf "%VF_FILTER%" -c:v libx264 -profile:v high -level:v 4.2 -preset slow -crf 16 -maxrate 14500k -bufsize 29000k -pix_fmt yuv420p -colorspace bt709 -color_primaries bt709 -color_trc bt709 -color_range tv -c:a aac -b:a 320k -ar 48000 -brand mp42 -movflags +faststart "%STAGE1_TEMP%"

if errorlevel 1 (
    echo [!] Ошибка перекодирования, пробуем прямой stream-copy...
    "%FFMPEG_EXE%" -nostdin -y -hide_banner -i "%SRC_FILE%" -map_metadata -1 -metadata make="Apple" -metadata model="iPhone 16 Pro" -c:v copy -c:a aac -b:a 320k -ar 48000 -brand mp42 -movflags +faststart "%STAGE1_TEMP%"
)

if not exist "%STAGE1_TEMP%" (
    echo [ERROR] Не удалось подготовить видео.
    pause
    exit /b
)

echo.
echo [*] Этап 2: Бинарный патч контейнера (%PATCH_MODE% FastStart Sentinel)...
set "PATCHER_PY=%~dp0rose_patcher.py"
if not exist "%PATCHER_PY%" set "PATCHER_PY=C:\Users\zurbi\.gemini\antigravity\scratch\encodex-base\GITHUB_REPO\rose_patcher.py"
python "%PATCHER_PY%" "%STAGE1_TEMP%" "%FINAL_OUT%" --mode %PATCH_MODE%

if exist "%STAGE1_TEMP%" del /f /q "%STAGE1_TEMP%"

echo.
if exist "%FINAL_OUT%" (
    echo ===========================================================================
    echo   [OK] ГОТОВО! ВИДЕО ЗАЩИЩЕНО ОТ СЖАТИЯ В 576p / 1024p 30FPS:
    echo        "%FINAL_OUT%"
    echo.
    echo   ВАЖНЫЕ ПРАВИЛА ДЛЯ ПУБЛИКАЦИИ:
    echo   1. В приложении TikTok: 'Дополнительные параметры' -^> включите
    echo      'Разрешить загрузку в высоком качестве'.
    echo   2. При отправке на телефон через Telegram - отправляйте как ФАЙЛ.
    echo   3. Первые 2-3 минуты после публикации TikTok может отдавать 576p превью,
    echo      пока CDN кэширует 1080p поток. Подождите 3-5 минут!
    echo ===========================================================================
) else (
    echo [ERROR] Ошибка при создании финального патча.
)
pause
