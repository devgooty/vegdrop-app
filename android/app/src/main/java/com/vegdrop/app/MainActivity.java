package com.vegdrop.app;

import android.Manifest;
import android.content.ActivityNotFoundException;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.location.LocationManager;
import android.os.Bundle;
import android.provider.Settings;
import android.webkit.WebView;
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

public class MainActivity extends BridgeActivity {
    /**
     * Once per launch, not once per resume: a "No thanks" must not come back
     * every time the user returns from Razorpay or the camera. Static so a
     * rotation, which recreates the activity, does not count as a new launch.
     */
    private static boolean askedToEnableLocation = false;

    private boolean locationWasOff = false;

    private final ActivityResultLauncher<IntentSenderRequest> enableLocation =
        registerForActivityResult(new ActivityResultContracts.StartIntentSenderForResult(), result -> syncLocationState());

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        // Draw behind a transparent status bar so each screen's own header colour
        // runs to the top. The site pads for it with env(safe-area-inset-top)
        // (viewport-fit=cover); Android 15+ forces this anyway, older versions don't.
        WindowCompat.setDecorFitsSystemWindows(getWindow(), false);
    }

    @Override
    public void onResume() {
        super.onResume();
        askToEnableLocation();
        syncLocationState();
    }

    /** Also fires when the quick-settings shade closes, which does not pause the activity. */
    @Override
    public void onWindowFocusChanged(boolean hasFocus) {
        super.onWindowFocusChanged(hasFocus);
        if (hasFocus) syncLocationState();
    }

    /**
     * The page asks for a position as it opens (MarketPicker), but with the
     * device's location switched off that request simply fails — a WebView has no
     * way to offer to turn it on. This shows Google's one-tap "Turn on location"
     * dialog instead.
     *
     * Only once the app holds the permission: without it a position cannot be
     * read either way, and on a first launch the page's own permission prompt
     * comes first — this then runs on the onResume that follows it closing.
     */
    private void askToEnableLocation() {
        if (askedToEnableLocation || !hasLocationPermission() || isLocationOn()) return;
        askedToEnableLocation = true;

        LocationSettingsRequest request = new LocationSettingsRequest.Builder()
            .addLocationRequest(new LocationRequest.Builder(Priority.PRIORITY_BALANCED_POWER_ACCURACY, 10_000).build())
            .setAlwaysShow(true)
            .build();

        LocationServices.getSettingsClient(this)
            .checkLocationSettings(request)
            .addOnFailureListener(this, e -> {
                if (e instanceof ResolvableApiException) {
                    try {
                        enableLocation.launch(
                            new IntentSenderRequest.Builder(((ResolvableApiException) e).getResolution()).build()
                        );
                        return;
                    } catch (RuntimeException ignored) {
                        // Fall through to the plain dialog.
                    }
                }
                // No usable Google Play services (some Huawei phones, de-Googled ROMs).
                showLocationSettingsDialog();
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
                    // Nothing to open; the page still offers Retry.
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

    private boolean isLocationOn() {
        LocationManager manager = (LocationManager) getSystemService(LOCATION_SERVICE);
        return manager != null && LocationManagerCompat.isLocationEnabled(manager);
    }

    private boolean hasLocationPermission() {
        return (
            ContextCompat.checkSelfPermission(this, Manifest.permission.ACCESS_FINE_LOCATION) == PackageManager.PERMISSION_GRANTED ||
            ContextCompat.checkSelfPermission(this, Manifest.permission.ACCESS_COARSE_LOCATION) == PackageManager.PERMISSION_GRANTED
        );
    }
}
