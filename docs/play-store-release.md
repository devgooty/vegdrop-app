# Publishing VegDrop on Google Play

The Android app is a Capacitor shell that opens the live website (see
CLAUDE.md, "Android app"). Getting it onto Play needs three things this
repository cannot do by itself — a Play Console account, an upload key, and a
closed test — plus one build workflow it can.

What the repository already has, so it is not redone:

- `targetSdkVersion 36` (`android/variables.gradle`), which is what Play
  requires of new apps and updates from 31 August 2026.
- `.github/workflows/android-release.yml`: builds the signed `.aab` Play
  accepts, by hand from the Actions tab, with `versionCode` taken from the run
  number so every upload is higher than the last.
- Keystores are git-ignored. **This repository is public**; a committed upload
  key would let anyone publish builds as VegDrop.

## 1. Play Console account (owner, takes days)

Sign up at play.google.com/console. One-time fee, identity verification with a
government ID, and a phone. Verification can take several days, so start it
first.

**Personal or organization decides how long launch takes.** Personal accounts
created after 13 November 2023 must run a **closed test with at least 12
testers, opted in continuously for 14 days**, before Play will consider a
production release. Organization accounts are exempt, but need a D-U-N-S
number for a registered business, which is free and can take a while to be
issued. Check Google's own page before relying on these numbers; they have
changed before (it was 20 testers until December 2024):
https://support.google.com/googleplay/android-developer/answer/14151465

## 2. Upload key (owner, once, on your own computer)

Made on your computer, not in CI and not by an assistant, so the private key
never exists anywhere else. Needs a JDK for `keytool`:

```powershell
winget install --id EclipseAdoptium.Temurin.21.JDK -e
```

Open a **new** PowerShell window (so `keytool` is on the PATH), then:

```powershell
keytool -genkeypair -v -keystore "$env:USERPROFILE\vegdrop-upload.jks" -alias upload -keyalg RSA -keysize 2048 -validity 10000
```

It asks for a password and a few name fields ("VegDrop" is fine for all of
them). Modern keytool writes a PKCS12 store, where the key password is the same
as the store password.

**Back it up now**: the `.jks` file and its password, somewhere private that is
not this repository. Google holds the real app-signing key (Play App Signing),
so a lost upload key can be reset through Play Console support — but that takes
days, and no update ships meanwhile.

Copy the key to the clipboard as base64:

```powershell
[Convert]::ToBase64String([IO.File]::ReadAllBytes("$env:USERPROFILE\vegdrop-upload.jks")) | Set-Clipboard
```

In GitHub: the repository → Settings → Secrets and variables → Actions → New
repository secret, four times:

| Name | Value |
|---|---|
| `ANDROID_UPLOAD_KEYSTORE_BASE64` | paste the clipboard |
| `ANDROID_UPLOAD_STORE_PASSWORD` | the password |
| `ANDROID_UPLOAD_KEY_ALIAS` | `upload` |
| `ANDROID_UPLOAD_KEY_PASSWORD` | the same password |

## 3. Build the bundle

Actions tab → **Build Android release (Play Store)** → Run workflow. The
download is `vegdrop-release-aab` → `app-release.aab`. The workflow refuses to
start if a secret is missing and refuses to finish if the bundle came out
unsigned, so a green run is an uploadable file.

The workflow only appears in the Actions tab once it is on `main`.

## 4. Closed test

Play Console → the app → Testing → Closed testing → create a release, upload
the `.aab`, add testers by Gmail address (or a Google Group), and send them the
opt-in link. They install from Play, not from an `.apk` file.

**Anyone who sideloaded the debug APK must uninstall it first.** Same package
name, different signature: Android refuses to install one over the other.

## Things Play will ask that need a decision first

- **Privacy policy URL.** Required: the app asks for location, camera and
  microphone, and takes payments and phone numbers.
- **Data safety form.** What is collected and who it goes to — including that
  payments go through Razorpay and, when `OPENAI_API_KEY` is set, that the
  cooking and voice assistants send the customer's words to OpenAI.
- **App access.** Reviewers must be able to get past sign-in, and sign-in here
  is a code sent to a phone they do not have. Do **not** answer this by turning
  on `DEV_LOGIN` anywhere real; it mints a session with nothing proved (see
  CLAUDE.md). This needs a deliberate design before the production review.
- **A website in a wrapper** can be rejected under Play's minimum-functionality
  rules. VegDrop has native location and speech plugins, which helps; it is
  still a risk worth knowing about.
- **The app's address is fixed in the build** (`server.url` in
  `capacitor.config.json`). If the website moves to its own domain, that is one
  Play update — easy once the app is on Play, which is part of why to publish
  there rather than share `.apk` files.
