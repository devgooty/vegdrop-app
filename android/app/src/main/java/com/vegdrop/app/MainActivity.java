package com.vegdrop.app;

import android.os.Bundle;
import androidx.core.view.WindowCompat;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        // Draw behind a transparent status bar so each screen's own header colour
        // runs to the top. The site pads for it with env(safe-area-inset-top)
        // (viewport-fit=cover); Android 15+ forces this anyway, older versions don't.
        WindowCompat.setDecorFitsSystemWindows(getWindow(), false);
    }
}
