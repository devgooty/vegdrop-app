package com.vegdrop.app;

import android.Manifest;
import android.content.Intent;
import android.os.Bundle;
import android.speech.RecognitionListener;
import android.speech.RecognizerIntent;
import android.speech.SpeechRecognizer;
import android.speech.tts.TextToSpeech;
import android.speech.tts.UtteranceProgressListener;
import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;
import java.util.ArrayList;
import java.util.Locale;

/**
 * The microphone, for a WebView that has none.
 *
 * `SpeechRecognition` is a browser API that Android's WebView does not
 * implement, so every voice feature on the site — the header mic, the shopping
 * list, and the cooking assistant — reaches the overlay's `unsupported` state
 * inside the app while working perfectly in Chrome. This plugin is what the
 * page calls instead (src/services/nativeSpeech.js), through the bridge
 * Capacitor injects into the live site, exactly as LocationPlugin is.
 *
 * `SpeechRecognizer` rather than the `RecognizerIntent` dialog, deliberately:
 * the dialog is Google's own full-screen sheet, and the site already draws its
 * own listening overlay. Two of them is two cancel buttons and two states to
 * keep in step.
 *
 * Results are delivered as events rather than as the call's return value,
 * because partial results arrive repeatedly while one `start()` is still
 * running — a resolved call cannot report them, and the overlay shows the words
 * as they are spoken.
 */
@CapacitorPlugin(
    name = "VegDropSpeech",
    permissions = { @Permission(alias = "microphone", strings = { Manifest.permission.RECORD_AUDIO }) }
)
public class SpeechPlugin extends Plugin {

    private SpeechRecognizer recognizer;
    private boolean listening = false;

    private TextToSpeech tts;
    private boolean ttsReady = false;

    @PluginMethod
    public void available(PluginCall call) {
        JSObject out = new JSObject();
        out.put("available", SpeechRecognizer.isRecognitionAvailable(getContext()));
        out.put("granted", getPermissionState("microphone") == com.getcapacitor.PermissionState.GRANTED);
        out.put("canSpeak", true);
        call.resolve(out);
    }

    /**
     * Say something out loud.
     *
     * Speaking is HALF of a voice agent, and the WebView cannot do this half
     * either: `speechSynthesis` is as absent as `SpeechRecognition`, so a page
     * that narrated the screen would be answering in silence.
     *
     * A language the phone has no voice for resolves `spoken: false` rather
     * than rejecting. Telugu and Hindi voices are downloaded packs and plenty
     * of handsets lack them — the page then shows the same sentence as text,
     * which is a complete answer, where an error would read as a broken
     * feature.
     */
    @PluginMethod
    public void speak(PluginCall call) {
        final String text = call.getString("text", "");
        final String locale = call.getString("locale", "en-IN");
        if (text.trim().isEmpty()) {
            call.reject("Nothing to say.");
            return;
        }

        withTts(call, engine -> {
            int set = engine.setLanguage(Locale.forLanguageTag(locale));
            if (set == TextToSpeech.LANG_MISSING_DATA || set == TextToSpeech.LANG_NOT_SUPPORTED) {
                // Try the language without its region ("te" for "te-IN") before
                // giving up: a phone may hold a generic voice and no Indian one.
                String base = locale.split("-")[0];
                set = engine.setLanguage(Locale.forLanguageTag(base));
            }
            if (set == TextToSpeech.LANG_MISSING_DATA || set == TextToSpeech.LANG_NOT_SUPPORTED) {
                JSObject out = new JSObject();
                out.put("spoken", false);
                out.put("reason", "language-unavailable");
                call.resolve(out);
                return;
            }

            // FLUSH, not ADD: the newest sentence is the one the shopper is
            // waiting on, and a queue of stale narration read out over a screen
            // they have already left is worse than saying nothing.
            engine.speak(text, TextToSpeech.QUEUE_FLUSH, null, "vegdrop");
            JSObject out = new JSObject();
            out.put("spoken", true);
            call.resolve(out);
        });
    }

    @PluginMethod
    public void stopSpeaking(PluginCall call) {
        if (tts != null && ttsReady) tts.stop();
        call.resolve();
    }

    /** Run something once the engine is up, creating it on first use. */
    private void withTts(PluginCall call, java.util.function.Consumer<TextToSpeech> ready) {
        if (tts != null && ttsReady) {
            ready.accept(tts);
            return;
        }
        if (tts != null) {
            call.reject("Still starting the voice engine.");
            return;
        }

        tts = new TextToSpeech(getContext(), status -> {
            if (status != TextToSpeech.SUCCESS) {
                tts = null;
                ttsReady = false;
                call.reject("No voice engine on this device.");
                return;
            }
            ttsReady = true;
            tts.setOnUtteranceProgressListener(new UtteranceProgressListener() {
                @Override public void onStart(String id) {}
                @Override public void onDone(String id) { notifyListeners("speakEnd", new JSObject()); }
                @Override public void onError(String id) { notifyListeners("speakEnd", new JSObject()); }
            });
            ready.accept(tts);
        });
    }

    /**
     * Ask for the microphone, then start listening.
     *
     * The permission is requested here rather than left to the page: a WebView
     * `getUserMedia` prompt cannot grant an Android runtime permission, so a
     * site that asked politely would still be refused by the OS.
     */
    @PluginMethod
    public void start(PluginCall call) {
        if (getPermissionState("microphone") != com.getcapacitor.PermissionState.GRANTED) {
            requestPermissionForAlias("microphone", call, "afterMicPermission");
            return;
        }
        beginListening(call);
    }

    @PermissionCallback
    private void afterMicPermission(PluginCall call) {
        if (getPermissionState("microphone") != com.getcapacitor.PermissionState.GRANTED) {
            // The same name the browser API uses, so the page's existing
            // `mapSpeechError` reaches its permission copy unchanged.
            emitError("not-allowed");
            call.reject("Microphone permission denied.");
            return;
        }
        beginListening(call);
    }

    private void beginListening(PluginCall call) {
        final String locale = call.getString("locale", "en-IN");
        final boolean partials = Boolean.TRUE.equals(call.getBoolean("partialResults", true));
        final int maxResults = call.getInt("maxAlternatives", 5);

        getActivity().runOnUiThread(() -> {
            try {
                stopRecognizer();

                if (!SpeechRecognizer.isRecognitionAvailable(getContext())) {
                    emitError("service-not-allowed");
                    call.reject("No speech recognition service on this device.");
                    return;
                }

                recognizer = SpeechRecognizer.createSpeechRecognizer(getContext());
                recognizer.setRecognitionListener(new Listener());

                Intent intent = new Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH);
                intent.putExtra(
                    RecognizerIntent.EXTRA_LANGUAGE_MODEL,
                    RecognizerIntent.LANGUAGE_MODEL_FREE_FORM
                );
                intent.putExtra(RecognizerIntent.EXTRA_LANGUAGE, locale);
                // Telugu and Hindi recognition is a downloaded language pack. If
                // the phone lacks it the service falls back rather than failing,
                // which is why the preference is set and not demanded.
                intent.putExtra(RecognizerIntent.EXTRA_LANGUAGE_PREFERENCE, locale);
                intent.putExtra(RecognizerIntent.EXTRA_PARTIAL_RESULTS, partials);
                intent.putExtra(RecognizerIntent.EXTRA_MAX_RESULTS, maxResults);
                intent.putExtra(RecognizerIntent.EXTRA_CALLING_PACKAGE, getContext().getPackageName());

                listening = true;
                recognizer.startListening(intent);
                call.resolve();
            } catch (Exception e) {
                emitError("failed");
                call.reject("Could not start listening.", e);
            }
        });
    }

    @PluginMethod
    public void stop(PluginCall call) {
        getActivity().runOnUiThread(() -> {
            if (recognizer != null && listening) recognizer.stopListening();
            call.resolve();
        });
    }

    /** Cancel without waiting for a result — the overlay was dismissed. */
    @PluginMethod
    public void abort(PluginCall call) {
        getActivity().runOnUiThread(() -> {
            stopRecognizer();
            call.resolve();
        });
    }

    private void stopRecognizer() {
        listening = false;
        if (recognizer != null) {
            try {
                recognizer.cancel();
                recognizer.destroy();
            } catch (Exception ignored) {
                // Already torn down; nothing to report to the page.
            }
            recognizer = null;
        }
    }

    private void emitError(String name) {
        JSObject payload = new JSObject();
        payload.put("error", name);
        notifyListeners("speechError", payload);
    }

    /**
     * Android's error codes, mapped to the browser API's error NAMES.
     *
     * The page already maps those names to its overlay states in
     * `services/voiceSearch.js` → `mapSpeechError`, and that mapping carries
     * hard-won detail (why `network` is shown as "no speech" when the device
     * is online). Translating here means none of it has to be written twice.
     */
    private static String browserErrorName(int code) {
        switch (code) {
            case SpeechRecognizer.ERROR_AUDIO:
                return "audio-capture";
            case SpeechRecognizer.ERROR_INSUFFICIENT_PERMISSIONS:
                return "not-allowed";
            case SpeechRecognizer.ERROR_NO_MATCH:
            case SpeechRecognizer.ERROR_SPEECH_TIMEOUT:
                return "no-speech";
            case SpeechRecognizer.ERROR_NETWORK:
            case SpeechRecognizer.ERROR_NETWORK_TIMEOUT:
                return "network";
            case SpeechRecognizer.ERROR_CLIENT:
                return "aborted";
            case SpeechRecognizer.ERROR_RECOGNIZER_BUSY:
            case SpeechRecognizer.ERROR_SERVER:
            default:
                return "failed";
        }
    }

    private class Listener implements RecognitionListener {

        @Override
        public void onReadyForSpeech(Bundle params) {
            notifyListeners("speechStart", new JSObject());
        }

        @Override
        public void onPartialResults(Bundle partial) {
            emitResults(partial, false);
        }

        @Override
        public void onResults(Bundle results) {
            emitResults(results, true);
            listening = false;
            notifyListeners("speechEnd", new JSObject());
        }

        @Override
        public void onError(int code) {
            listening = false;
            emitError(browserErrorName(code));
            notifyListeners("speechEnd", new JSObject());
        }

        private void emitResults(Bundle bundle, boolean isFinal) {
            ArrayList<String> heard = bundle.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION);
            if (heard == null || heard.isEmpty()) return;

            JSArray alternatives = new JSArray();
            for (String text : heard) alternatives.put(text);

            JSObject payload = new JSObject();
            // The page reads every alternative, not just the first: an exact
            // catalog hit on the recogniser's third guess beats a near miss on
            // its favourite ("lettuce" over "let us").
            payload.put("transcripts", alternatives);
            payload.put("isFinal", isFinal);
            notifyListeners("speechResult", payload);
        }

        @Override public void onBeginningOfSpeech() {}
        @Override public void onRmsChanged(float rmsdB) {}
        @Override public void onBufferReceived(byte[] buffer) {}
        @Override public void onEndOfSpeech() {}
        @Override public void onEvent(int eventType, Bundle params) {}
    }

    @Override
    protected void handleOnDestroy() {
        stopRecognizer();
        if (tts != null) {
            tts.stop();
            tts.shutdown();
            tts = null;
            ttsReady = false;
        }
    }
}
