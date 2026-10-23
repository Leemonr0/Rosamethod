@echo off
chcp 65001 >nul
title Rose Method - Auto Quality TikTok 1080p 60FPS
echo ===========================================================================
echo   ROSE METHOD PRO // АВТО-КАЧЕСТВО 1080p 60FPS + ОБХОД СЖАТИЯ TIKTOK
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
set "FINAL_OUT=%~dp1IMG_%RANDOM%_rose_1080p60.mp4"

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
echo [*] Этап 1: Нормализация потока: CRF 16, VBV 14.5M cap, 60 FPS CFR, BT.709...
echo [*] Метаданные: Apple iPhone 16 Pro iOS 18.3.1 Core Media...
echo.

"%FFMPEG_EXE%" -nostdin -y -hide_banner -i "%SRC_FILE%" -map_metadata -1 -metadata make="Apple" -metadata model="iPhone 16 Pro" -metadata software="18.3.1" -metadata:s:v:0 handler_name="Core Media Video" -metadata:s:a:0 handler_name="Core Media Audio" -vf "scale=1080:1920:force_original_aspect_ratio=decrease,pad=1080:1920:(ow-iw)/2:(oh-ih)/2,format=yuv420p" -r 60 -fps_mode cfr -g 120 -c:v libx264 -profile:v high -level:v 4.2 -preset slow -crf 16 -maxrate 14500k -bufsize 29000k -pix_fmt yuv420p -colorspace bt709 -color_primaries bt709 -color_trc bt709 -color_range tv -c:a aac -b:a 320k -ar 48000 -brand mp42 -movflags +faststart "%STAGE1_TEMP%"

if errorlevel 1 (
    echo [!] FFmpeg с кодированием завершился с кодом ошибки, пробуем stream-copy...
    "%FFMPEG_EXE%" -nostdin -y -hide_banner -i "%SRC_FILE%" -map_metadata -1 -metadata make="Apple" -metadata model="iPhone 16 Pro" -c:v copy -c:a aac -b:a 320k -ar 48000 -brand mp42 -movflags +faststart "%STAGE1_TEMP%"
)

if not exist "%STAGE1_TEMP%" (
    echo [ERROR] Не удалось подготовить видео через FFmpeg.
    pause
    exit /b
)

echo.
echo [*] Этап 2: Бинарный патч контейнера Rose Method: Enhancer 10x 8B NAL Filler...
python "%~dp0rose_patcher.py" "%STAGE1_TEMP%" "%FINAL_OUT%" --mode enhancer

if exist "%STAGE1_TEMP%" del /f /q "%STAGE1_TEMP%"

echo.
if exist "%FINAL_OUT%" (
    echo ===========================================================================
    echo   [OK] ГОТОВО! ВИДЕО ПОЛНОСТЬЮ ЗАЩИЩЕНО ОТ СЖАТИЯ TIKTOK:
    echo        "%FINAL_OUT%"
    echo.
    echo   ВАЖНЫЕ ПРАВИЛА ДЛЯ 100%% КАЧЕСТВА:
    echo   1. При публикации в приложении TikTok включите тумблер
    echo      'Разрешить загрузку в высоком качестве' в Доп. параметрах.
    echo   2. Если передаете на телефон через Telegram - отправляйте как ФАЙЛ.
    echo   3. Либо загрузите напрямую с ПК: https://www.tiktok.com/creator-center/upload
    echo   4. Первые 2-3 минуты после публикации TikTok показывает 576p превью,
    echo      пока CDN кеширует 1080p поток. Подождите 3-5 минут!
    echo ===========================================================================
) else (
    echo [ERROR] Ошибка при создании финального патча.
)
pause
