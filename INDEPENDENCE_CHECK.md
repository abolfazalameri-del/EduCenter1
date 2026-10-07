# استقلال برنامه مدیریت مراکز آموزشی

این نسخه یک برنامه مستقل است و نباید هیچ داده، کاربر، رمز عبور، پشتیبان یا مسیر
ذخیره‌سازی برنامه دیگری را استفاده کند.

- Application ID: `com.educenter.manager`
- Product name: `مدیریت مراکز آموزشی`
- Backup prefix: `EduCenter-Backup_`
- User-data override for CI: `EDUCENTER_USERDATA`
- Self-test variable for CI: `EDUCENTER_SELFTEST`

Restore فقط پشتیبان‌هایی را می‌پذیرد که `app` آنها دقیقاً `edu-center` باشد.
