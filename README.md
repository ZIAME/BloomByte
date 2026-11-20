# BloomByte

A tiny pixel-art focus timer that grows butterflies, with notes and a butterfly journal. Use it as a normal Windows app or as a widget that floats in the corner of your screen.

Every focus session you finish turns a caterpillar into a butterfly. End early and it stays a chrysalis.

## Run it locally

```
npm install
npm start
```

## Microsoft Store package

The Store build is made by GitHub Actions on a Windows machine:

1. Open the **Actions** tab, pick **Build Microsoft Store package**, click **Run workflow** (branch `desktop-app`).
2. When it finishes, download the **BloomByte-Store-package** artifact. It contains the `.appx` file.
3. Upload that file in Partner Center under **Packages**.

Before each new Store submission, raise `version` in `package.json` (e.g. 0.5.0 → 0.5.1). The Store needs every upload to have a higher version.

Package identity (from Partner Center) lives in `package.json` → `build.appx`.

## Where things are

- `main.js` – window, app/widget/pill modes, tray, saving data
- `preload.js` – safe bridge between the window and the app
- `src/` – the interface (`index.html`, `styles.css`, `app.js`), art, fonts
- `build/appx/` – Store logos and tiles

Art and design © Ziana.
