# ساخت فایل نصب ویندوز با GitHub (قدم‌به‌قدم)

1. در github.com وارد حساب خود شوید ← **New repository** ← یک نام (مثلاً `edu-center`) ← **Private** ← Create repository.
2. همین ZIP را روی کامپیوتر **Extract** کنید (پوشه‌ی بازشده شامل `index.html`، `main.js`، پوشه‌های `lib`، `test`، `build` و پوشه‌ی `.github` است).
3. در صفحه‌ی مخزن: **uploading an existing file** ← **همه‌ی فایل‌ها و پوشه‌های داخل** پوشه‌ی Extract‌شده را بکشید و رها کنید (پوشه‌ی `.github` حتماً باشد؛ اگر دیده نمی‌شود در ویندوز Folder Options ← Show hidden files را روشن کنید) ← پایین صفحه **Commit changes**.
4. تب **Actions** ← در صورت درخواست **I understand my workflows… Enable** ← از چپ «Build Windows Installer» ← **Run workflow** (اگر خودکار شروع شده بود صبر کنید).
5. حدود ۱۵ تا ۳۰ دقیقه صبر کنید. هر دو بخش (test و windows-build) باید سبز شوند.
6. روی اجرای تمام‌شده کلیک کنید ← پایین صفحه، بخش **Artifacts** ← `EduCenterManager-Windows-Installer` را دانلود و Extract کنید ← داخلش `EduCenterManager-Setup-1.0.0.exe` است.
7. نصب: روی فایل دوبار کلیک کنید. اگر ویندوز هشدار «Windows protected your PC» داد: **More info ← Run anyway** (چون فایل امضای دیجیتال ندارد).
8. اولین اجرا: حساب مدیر را بسازید؛ سپس «تنظیمات» ← نام، لوگو و رنگ مرکز.

اگر در Actions خطای قرمز دیدید: روی مرحله‌ی قرمز کلیک کنید، متن خطا را کپی کنید و برای من بفرستید.
