# Hands-free Scroll

Browser extension that scrolls TikTok, Instagram Reels, Facebook Reels and YouTube Shorts for you.

- **Auto**: goes to the next video when the current one ends (also catches videos that loop, like Reels). Optional delay and "max time per video".
- **Sound**: record any noise 3 times (tongue click, whistle, finger snap…). Make that noise again and it skips to the next video. Other noises are ignored.
- **Both**: auto-next, plus skip early with your sound.

A small round button shows up on feed pages. Tap it to open the panel.

## How the sound trigger works

Everything runs locally in the page. No audio leaves the device.

1. When you record, it finds the loudest event in a 2 s clip and turns it into MFCC features (`src/dsp.js`).
2. While listening, a segmenter waits for any sound that pops out of the background noise.
3. Each sound gets compared with your samples using DTW. If it's close enough, the extension skips. The threshold calibrates itself from how different your 3 samples are from each other; the Sensitivity slider scales it.

The mic uses echo cancellation, so the video's own audio mostly doesn't count. Headphones make it even more reliable.

## Install

### Desktop Chrome / Edge / Brave
1. `chrome://extensions` → turn on **Developer mode**
2. **Load unpacked** → pick this folder
3. Open tiktok.com, youtube.com/shorts or instagram.com/reels

### Desktop Firefox
`about:debugging` → This Firefox → **Load Temporary Add-on** → pick `manifest.json`.

### Android (Firefox)
Firefox for Android only installs signed add-ons. Upload the zip to [addons.mozilla.org](https://addons.mozilla.org/developers/) as **unlisted** (self-distribution). Signing is free and automatic, and you get an `.xpi` you can install on your phone.

## Test

```
node test/dsp.test.js
```

## Next ideas
- Bluetooth "puck" (ESP32-S3 + mic as a BLE mouse) so it works inside the native apps on iPhone and Android
- Android app version (AccessibilityService + foreground mic service)
