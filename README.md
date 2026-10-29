# Quiz Bank (Android)

Offline quiz & flashcard app for Excel question banks (11-column format:
Nomor, Soal, Pilihan A–D, Jawaban Benar, Pembahasan jika Pilihan A–D).

## Download

Open **Releases** → latest version → download `QuizBank-v1.0.N.apk` on the phone and install it.

## How the APK is built

Every push to `main` runs `.github/workflows/build.yml` on GitHub Actions, which builds
`app/` with the official Android Gradle plugin and publishes the signed APK as a release.
The signing key lives encrypted in `app/keystore/`; its password is the
`KEYSTORE_PASSWORD` repository secret.

## Layout

```
app/src/main/java/.../MainActivity.java   WebView host: file picker, save dialog, back button
app/src/main/assets/www/                  the app itself (HTML/CSS/JS, works offline)
tools/                                    icon generator and test helpers
```
