package com.firzan.quizbank;

import android.app.Activity;
import android.content.ActivityNotFoundException;
import android.content.ClipData;
import android.content.Intent;
import android.content.pm.PackageInfo;
import android.graphics.Color;
import android.net.Uri;
import android.os.Bundle;
import android.util.Base64;
import android.view.WindowManager;
import android.webkit.JavascriptInterface;
import android.webkit.RenderProcessGoneDetail;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;

import org.json.JSONObject;

import java.io.ByteArrayInputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.util.HashMap;
import java.util.Locale;
import java.util.Map;

/**
 * Hosts the Quiz Bank web app (bundled in assets/www) inside a WebView.
 *
 * <p>The pages are served from a virtual https origin so that IndexedDB and
 * localStorage behave like a normal secure website. Native duties:
 * <ul>
 *   <li>file picker for the "Attach Excel" button (Storage Access Framework),</li>
 *   <li>saving CSV / JSON exports to a location the user chooses,</li>
 *   <li>routing the hardware Back button to the web app first,</li>
 *   <li>keeping the screen awake during a timed session.</li>
 * </ul>
 */
public class MainActivity extends Activity {

    static final String ASSET_HOST = "appassets.androidplatform.net";
    static final String START_URL = "https://" + ASSET_HOST + "/www/index.html";

    private static final int REQUEST_PICK_FILE = 4101;
    private static final int REQUEST_SAVE_FILE = 4102;

    private WebView webView;
    private boolean pageReady;
    private ValueCallback<Uri[]> pendingPick;
    private String pendingSaveId;
    private byte[] pendingSaveBytes;
    private String versionName = "";

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        try {
            PackageInfo info = getPackageManager().getPackageInfo(getPackageName(), 0);
            versionName = info.versionName == null ? "" : info.versionName;
        } catch (Exception ignored) {
            versionName = "";
        }
        buildWebView();
    }

    private void buildWebView() {
        pageReady = false;
        webView = new WebView(this);
        webView.setBackgroundColor(Color.parseColor("#0B0F19"));
        webView.setOverScrollMode(WebView.OVER_SCROLL_NEVER);

        WebSettings settings = webView.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setDatabaseEnabled(true);
        settings.setAllowFileAccess(false);
        settings.setAllowContentAccess(true);
        settings.setMediaPlaybackRequiresUserGesture(true);
        settings.setTextZoom(100);
        settings.setSupportZoom(false);
        settings.setBuiltInZoomControls(false);
        settings.setDisplayZoomControls(false);
        settings.setCacheMode(WebSettings.LOAD_NO_CACHE);

        webView.setWebViewClient(new AppClient());
        webView.setWebChromeClient(new AppChrome());
        webView.addJavascriptInterface(new NativeBridge(), "QuizBankNative");
        setContentView(webView);
        webView.loadUrl(START_URL);
    }

    // ------------------------------------------------------------------ lifecycle

    @Override
    protected void onResume() {
        super.onResume();
        if (webView != null) {
            webView.onResume();
        }
    }

    @Override
    protected void onPause() {
        if (webView != null) {
            webView.onPause();
        }
        super.onPause();
    }

    @Override
    protected void onDestroy() {
        if (pendingPick != null) {
            pendingPick.onReceiveValue(null);
            pendingPick = null;
        }
        if (webView != null) {
            webView.removeJavascriptInterface("QuizBankNative");
            webView.destroy();
            webView = null;
        }
        super.onDestroy();
    }

    @Override
    public void onBackPressed() {
        if (webView == null || !pageReady) {
            leaveApp();
            return;
        }
        webView.evaluateJavascript(
                "(function(){try{return window.__qbBack?!!window.__qbBack():false;}catch(e){return false;}})()",
                value -> {
                    if (!"true".equals(value)) {
                        leaveApp();
                    }
                });
    }

    private void leaveApp() {
        super.onBackPressed();
    }

    // ------------------------------------------------------------------ results

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        if (requestCode == REQUEST_PICK_FILE) {
            ValueCallback<Uri[]> callback = pendingPick;
            pendingPick = null;
            if (callback != null) {
                callback.onReceiveValue(pickedUris(resultCode, data));
            }
            return;
        }
        if (requestCode == REQUEST_SAVE_FILE) {
            finishSave(resultCode, data);
            return;
        }
        super.onActivityResult(requestCode, resultCode, data);
    }

    private static Uri[] pickedUris(int resultCode, Intent data) {
        if (resultCode != RESULT_OK || data == null) {
            return null;
        }
        ClipData clip = data.getClipData();
        if (clip != null && clip.getItemCount() > 0) {
            Uri[] uris = new Uri[clip.getItemCount()];
            for (int i = 0; i < uris.length; i++) {
                uris[i] = clip.getItemAt(i).getUri();
            }
            return uris;
        }
        Uri single = data.getData();
        return single == null ? null : new Uri[] {single};
    }

    // ------------------------------------------------------------------ saving

    private void startSave(String requestId, String fileName, String mimeType, String base64) {
        if (pendingSaveId != null) {
            notifySaved(pendingSaveId, false, "Replaced by a newer save request");
        }
        byte[] bytes;
        try {
            bytes = Base64.decode(base64 == null ? "" : base64, Base64.DEFAULT);
        } catch (IllegalArgumentException e) {
            notifySaved(requestId, false, "The file content could not be decoded");
            return;
        }
        pendingSaveId = requestId;
        pendingSaveBytes = bytes;
        Intent intent = new Intent(Intent.ACTION_CREATE_DOCUMENT);
        intent.addCategory(Intent.CATEGORY_OPENABLE);
        intent.setType(mimeType == null || mimeType.isEmpty() ? "application/octet-stream" : mimeType);
        intent.putExtra(Intent.EXTRA_TITLE, fileName == null || fileName.isEmpty() ? "export" : fileName);
        try {
            startActivityForResult(intent, REQUEST_SAVE_FILE);
        } catch (ActivityNotFoundException e) {
            pendingSaveId = null;
            pendingSaveBytes = null;
            notifySaved(requestId, false, "No file manager is available to save the file");
        }
    }

    private void finishSave(int resultCode, Intent data) {
        String requestId = pendingSaveId;
        byte[] bytes = pendingSaveBytes;
        pendingSaveId = null;
        pendingSaveBytes = null;
        if (requestId == null) {
            return;
        }
        if (resultCode != RESULT_OK || data == null || data.getData() == null || bytes == null) {
            notifySaved(requestId, false, "cancelled");
            return;
        }
        Uri target = data.getData();
        try (OutputStream out = getContentResolver().openOutputStream(target, "w")) {
            if (out == null) {
                throw new IOException("The destination could not be opened");
            }
            out.write(bytes);
            out.flush();
            notifySaved(requestId, true, "");
        } catch (Exception e) {
            String message = e.getMessage() == null ? e.getClass().getSimpleName() : e.getMessage();
            notifySaved(requestId, false, message);
        }
    }

    private void notifySaved(String requestId, boolean ok, String message) {
        if (webView == null) {
            return;
        }
        String script = "window.__qbNativeSaved&&window.__qbNativeSaved("
                + JSONObject.quote(requestId == null ? "" : requestId) + ","
                + (ok ? "true" : "false") + ","
                + JSONObject.quote(message == null ? "" : message) + ")";
        webView.evaluateJavascript(script, null);
    }

    // ------------------------------------------------------------------ WebView plumbing

    private static String mimeFor(String path) {
        String lower = path.toLowerCase(Locale.ROOT);
        if (lower.endsWith(".html") || lower.endsWith(".htm")) return "text/html";
        if (lower.endsWith(".js") || lower.endsWith(".mjs")) return "text/javascript";
        if (lower.endsWith(".css")) return "text/css";
        if (lower.endsWith(".json")) return "application/json";
        if (lower.endsWith(".svg")) return "image/svg+xml";
        if (lower.endsWith(".png")) return "image/png";
        if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) return "image/jpeg";
        if (lower.endsWith(".webp")) return "image/webp";
        if (lower.endsWith(".woff2")) return "font/woff2";
        if (lower.endsWith(".woff")) return "font/woff";
        if (lower.endsWith(".ttf")) return "font/ttf";
        if (lower.endsWith(".txt")) return "text/plain";
        return "application/octet-stream";
    }

    private static boolean isText(String mime) {
        return mime.startsWith("text/") || mime.equals("application/json") || mime.equals("image/svg+xml");
    }

    private WebResourceResponse notFound() {
        Map<String, String> headers = new HashMap<>();
        headers.put("Cache-Control", "no-store");
        return new WebResourceResponse("text/plain", "UTF-8", 404, "Not Found", headers,
                new ByteArrayInputStream(new byte[0]));
    }

    private final class AppClient extends WebViewClient {
        @Override
        public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
            Uri url = request.getUrl();
            if (url == null || !ASSET_HOST.equals(url.getHost())) {
                return null;
            }
            String path = url.getPath();
            if (path == null) {
                return notFound();
            }
            while (path.startsWith("/")) {
                path = path.substring(1);
            }
            if (path.isEmpty() || path.contains("..")) {
                return notFound();
            }
            try {
                InputStream stream = getAssets().open(path);
                String mime = mimeFor(path);
                Map<String, String> headers = new HashMap<>();
                headers.put("Cache-Control", "no-store");
                return new WebResourceResponse(mime, isText(mime) ? "UTF-8" : null, 200, "OK", headers, stream);
            } catch (IOException e) {
                return notFound();
            }
        }

        @Override
        public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
            Uri url = request.getUrl();
            if (url != null && ASSET_HOST.equals(url.getHost())) {
                return false;
            }
            if (url != null) {
                try {
                    startActivity(new Intent(Intent.ACTION_VIEW, url));
                } catch (Exception ignored) {
                    // No app can open the link; stay in Quiz Bank.
                }
            }
            return true;
        }

        @Override
        public void onPageFinished(WebView view, String url) {
            pageReady = true;
        }

        @Override
        public boolean onRenderProcessGone(WebView view, RenderProcessGoneDetail detail) {
            // The page renderer crashed or was killed to free memory: rebuild the
            // WebView instead of letting the whole app crash. State lives in storage.
            if (webView == view) {
                webView = null;
                view.destroy();
                buildWebView();
            }
            return true;
        }
    }

    private final class AppChrome extends WebChromeClient {
        @Override
        public boolean onShowFileChooser(WebView view, ValueCallback<Uri[]> callback, FileChooserParams params) {
            if (pendingPick != null) {
                pendingPick.onReceiveValue(null);
            }
            pendingPick = callback;
            Intent intent = new Intent(Intent.ACTION_GET_CONTENT);
            intent.addCategory(Intent.CATEGORY_OPENABLE);
            // "*/*" on purpose: Excel files often arrive with a generic MIME type
            // (e.g. from WhatsApp or Drive); the web app validates the file itself.
            intent.setType("*/*");
            if (params != null && params.getMode() == FileChooserParams.MODE_OPEN_MULTIPLE) {
                intent.putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true);
            }
            try {
                startActivityForResult(intent, REQUEST_PICK_FILE);
                return true;
            } catch (ActivityNotFoundException e) {
                pendingPick = null;
                return false;
            }
        }
    }

    /** Methods callable from JavaScript as window.QuizBankNative.*. */
    private final class NativeBridge {
        @JavascriptInterface
        public String platform() {
            return "android";
        }

        @JavascriptInterface
        public String appVersion() {
            return versionName;
        }

        @JavascriptInterface
        public void saveFile(final String requestId, final String fileName, final String mimeType,
                             final String base64) {
            runOnUiThread(() -> startSave(requestId, fileName, mimeType, base64));
        }

        @JavascriptInterface
        public void setKeepScreenOn(final boolean keepOn) {
            runOnUiThread(() -> {
                if (keepOn) {
                    getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
                } else {
                    getWindow().clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
                }
            });
        }
    }
}
