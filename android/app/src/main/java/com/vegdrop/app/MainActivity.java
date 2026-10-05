package com.vegdrop.app;

import android.Manifest;
import android.content.ActivityNotFoundException;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.location.LocationManager;
import android.os.Bundle;
import android.provider.Settings;
import android.webkit.WebView;
import androidx.activity.OnBackPressedCallback;
import androidx.activity.result.ActivityResultLauncher;
import androidx.activity.result.IntentSenderRequest;
import androidx.activity.result.contract.ActivityResultContracts;
import androidx.appcompat.app.AlertDialog;
import androidx.core.content.ContextCompat;
import androidx.core.location.LocationManagerCompat;
import androidx.core.view.WindowCompat;
import com.getcapacitor.BridgeActivity;
import com.google.android.gms.common.api.ResolvableApiException;
import com.google.android.gms.location.LocationRequest;
import com.google.android.gms.location.LocationServices;
import com.google.android.gms.location.LocationSettingsRequest;
import com.google.android.gms.location.Priority;
import java.util.function.Consumer;

public class MainActivity extends BridgeActivity {

    private boolean locationWasOff = false;

    // Told whether location ended up on, once Google's dialog closes.
    private Consumer<Boolean> pendingEnable;

    private final ActivityResultLauncher<IntentSenderRequest> enableLocation = registerForActivityResult(
        new ActivityResultContracts.StartIntentSenderForResult(),
        result -> {
            syncLocationState();
            Consumer<Boolean> done = pendingEnable;
            pendingEnable = null;
            if (done != null) done.accept(isLocationOn());
        }
    );

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        // Before super: Capacitor reads the plugin list while creating the bridge.
        registerPlugin(LocationPlugin.class);
        super.onCreate(savedInstanceState);
        // Draw behind a transparent status bar so each screen's own header colour
        // runs to the top. The site pads for it with env(safe-area-inset-top)
        // (viewport-fit=cover); Android 15+ forces this anyway, older versions don't.
        WindowCompat.setDecorFitsSystemWindows(getWindow(), false);

        /*
         * Back steps back through the page's own history.
         *
         * Capacitor's core does not handle the button at all — that lives in the
         * App plugin, which this app does not use — so it fell through to
         * Android's default and closed VegDrop from every screen: a product page,
         * the basket, the sign-in screen. The site keeps one history entry per
         * thing on screen (src/lib/backStack.js), so going back one entry is
         * exactly "close what is on top". With none left, the default applies.
         */
        getOnBackPressedDispatcher().addCallback(this, new OnBackPressedCallback(true) {
            @Override
            public void handleOnBackPressed() {
                WebView webView = getBridge() == null ? null : getBridge().getWebView();
                if (webView != null && webView.canGoBack()) {
                    webView.goBack();
                    return;
                }
                setEnabled(false);
                getOnBackPressedDispatcher().onBackPressed();
                setEnabled(true);
            }
        });
    }

    @Override
    public void onResume() {
        super.onResume();
        syncLocationState();
    }

    /** Also fires when the quick-settings shade closes, which does not pause the activity. */
    @Override
    public void onWindowFocusChanged(boolean hasFocus) {
        super.onWindowFocusChanged(hasFocus);
        if (hasFocus) syncLocationState();
    }

    /**
     * Google's one-tap "Turn on location" dialog. Called by LocationPlugin when
     * the page's "Enable device location" is tapped (LocationRequiredSheet) —
     * a WebView has no way to offer this itself, so with location off the
     * page's position request simply failed.
     */
    public void promptEnableLocation(Consumer<Boolean> done) {
        LocationSettingsRequest request = new LocationSettingsRequest.Builder()
            .addLocationRequest(new LocationRequest.Builder(Priority.PRIORITY_BALANCED_POWER_ACCURACY, 10_000).build())
            .setAlwaysShow(true)
            .build();

        LocationServices.getSettingsClient(this)
            .checkLocationSettings(request)
            .addOnSuccessListener(this, response -> done.accept(isLocationOn()))
            .addOnFailureListener(this, e -> {
                if (e instanceof ResolvableApiException) {
                    try {
                        pendingEnable = done;
                        enableLocation.launch(
                            new IntentSenderRequest.Builder(((ResolvableApiException) e).getResolution()).build()
                        );
                        return;
                    } catch (RuntimeException ignored) {
                        pendingEnable = null;
                    }
                }
                // No usable Google Play services (some Huawei phones, de-Googled ROMs).
                showLocationSettingsDialog();
                done.accept(false);
            });
    }

    private void showLocationSettingsDialog() {
        if (isFinishing() || isDestroyed()) return;
        new AlertDialog.Builder(this)
            .setTitle(R.string.location_off_title)
            .setMessage(R.string.location_off_message)
            .setPositiveButton(R.string.location_off_open_settings, (dialog, which) -> {
                try {
                    startActivity(new Intent(Settings.ACTION_LOCATION_SOURCE_SETTINGS));
                } catch (ActivityNotFoundException ignored) {
                    // Nothing to open; the page still offers to pick an address by hand.
                }
            })
            .setNegativeButton(R.string.location_off_not_now, null)
            .show();
    }

    /**
     * Tell the page when location comes on, however it happened — the dialog
     * above, Settings, or the quick-settings tile. Its first attempt failed while
     * location was off and nothing would otherwise make it try again.
     */
    private void syncLocationState() {
        boolean on = isLocationOn();
        if (on && locationWasOff) {
            WebView webView = getBridge() == null ? null : getBridge().getWebView();
            if (webView != null) {
                webView.evaluateJavascript("window.dispatchEvent(new Event('vegdrop:locationon'))", null);
            }
        }
        locationWasOff = !on;
    }

    public boolean isLocationOn() {
        LocationManager manager = (LocationManager) getSystemService(LOCATION_SERVICE);
        return manager != null && LocationManagerCompat.isLocationEnabled(manager);
    }

    /** Approximate is enough: the page only needs which markets are near. */
    public boolean hasLocationPermission() {
        return (
            ContextCompat.checkSelfPermission(this, Manifest.permission.ACCESS_FINE_LOCATION) == PackageManager.PERMISSION_GRANTED ||
            ContextCompat.checkSelfPermission(this, Manifest.permission.ACCESS_COARSE_LOCATION) == PackageManager.PERMISSION_GRANTED
        );
    }
}
