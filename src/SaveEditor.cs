using System;
using System.Collections.Generic;
using System.Drawing;
using System.Globalization;
using System.IO;
using System.Reflection;
using System.Security.Cryptography;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using System.Web.Script.Serialization;
using System.Windows.Forms;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;

namespace MyJianghuSaveEditor
{
    internal static class Program
    {
        internal const string AppTitle = "\ubabd\uac15\ud638 \uc138\uc774\ube0c \uc5d0\ub514\ud130 v1.1";
        internal const string VirtualHost = "myjh-editor.local";

        internal const string HtmlResourceName = "MyJianghuSaveEditor.html";
        internal const string CoreResourceName = "Microsoft.Web.WebView2.Core.dll";
        internal const string WinFormsResourceName = "Microsoft.Web.WebView2.WinForms.dll";
        internal const string LoaderResourceName = "WebView2Loader.dll";

        private static readonly object ResolveLock = new object();
        private static bool _resolverHooked;

        internal static readonly string LocalAppDataRoot =
            Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "MyJianghuSaveEditor");
        internal static readonly string RuntimeDir = Path.Combine(LocalAppDataRoot, "runtime-1.1.0");
        internal static readonly string HtmlDir = Path.Combine(LocalAppDataRoot, "html-1.1.0");
        internal static readonly string WebView2UserDataDir = Path.Combine(LocalAppDataRoot, "webview2-1.1.0");
        internal static readonly string HtmlPath = Path.Combine(HtmlDir, HtmlResourceName);

        [STAThread]
        private static int Main(string[] args)
        {
            try
            {
                RegisterAssemblyResolver();
                EnsureDirectories();
                ExtractRuntimeLoader();
                ExtractHtml();
                InitWebViewLoaderPath();

                if (args != null && args.Length >= 2 && string.Equals(args[0], "--self-test", StringComparison.OrdinalIgnoreCase))
                {
                    string outDir = args[1];
                    string seedSavePath = args.Length >= 3 ? args[2] : null;
                    return SelfTestRunner.Run(outDir, seedSavePath);
                }

                Application.EnableVisualStyles();
                Application.SetCompatibleTextRenderingDefault(false);
                Application.ThreadException += delegate(object s, ThreadExceptionEventArgs e)
                {
                    try { MessageBox.Show(e.Exception.Message, AppTitle, MessageBoxButtons.OK, MessageBoxIcon.Error); } catch { }
                };

                using (SaveEditorForm form = new SaveEditorForm())
                {
                    Application.Run(form);
                }
                return 0;
            }
            catch (Exception ex)
            {
                try { Console.Error.WriteLine(ex.ToString()); } catch { }
                return 1;
            }
        }

        private static void EnsureDirectories()
        {
            Directory.CreateDirectory(LocalAppDataRoot);
            Directory.CreateDirectory(RuntimeDir);
            Directory.CreateDirectory(HtmlDir);
            Directory.CreateDirectory(WebView2UserDataDir);
        }

        private static void RegisterAssemblyResolver()
        {
            lock (ResolveLock)
            {
                if (_resolverHooked)
                {
                    return;
                }
                _resolverHooked = true;
            }
            AppDomain.CurrentDomain.AssemblyResolve += delegate(object sender, ResolveEventArgs args)
            {
                try
                {
                    string simpleName = new AssemblyName(args.Name).Name;
                    if (string.Equals(simpleName, "Microsoft.Web.WebView2.Core", StringComparison.OrdinalIgnoreCase))
                    {
                        return LoadEmbeddedAssembly(CoreResourceName);
                    }
                    if (string.Equals(simpleName, "Microsoft.Web.WebView2.WinForms", StringComparison.OrdinalIgnoreCase))
                    {
                        return LoadEmbeddedAssembly(WinFormsResourceName);
                    }
                }
                catch
                {
                }
                return null;
            };
        }

        private static string FindResourceName(string fileName)
        {
            Assembly asm = Assembly.GetExecutingAssembly();
            string[] names = asm.GetManifestResourceNames();
            if (names == null) return null;
            for (int i = 0; i < names.Length; i++)
            {
                if (string.Equals(names[i], fileName, StringComparison.OrdinalIgnoreCase))
                {
                    return names[i];
                }
            }
            for (int i = 0; i < names.Length; i++)
            {
                if (names[i] != null && names[i].EndsWith("." + fileName, StringComparison.OrdinalIgnoreCase))
                {
                    return names[i];
                }
            }
            return null;
        }

        private static byte[] ReadEmbeddedBytes(string fileName)
        {
            string actual = FindResourceName(fileName);
            if (actual == null) return null;
            using (Stream stream = Assembly.GetExecutingAssembly().GetManifestResourceStream(actual))
            {
                if (stream == null) return null;
                using (MemoryStream ms = new MemoryStream())
                {
                    byte[] buffer = new byte[81920];
                    int read;
                    while ((read = stream.Read(buffer, 0, buffer.Length)) > 0)
                    {
                        ms.Write(buffer, 0, read);
                    }
                    return ms.ToArray();
                }
            }
        }

        private static Assembly LoadEmbeddedAssembly(string fileName)
        {
            byte[] bytes = ReadEmbeddedBytes(fileName);
            if (bytes == null || bytes.Length == 0) return null;
            return Assembly.Load(bytes);
        }

        private static void ExtractResourceIfChanged(string resourceName, string targetPath)
        {
            byte[] bytes = ReadEmbeddedBytes(resourceName);
            if (bytes == null || bytes.Length == 0)
            {
                throw new InvalidOperationException("Missing embedded resource: " + resourceName);
            }
            string sourceSha = SaveStore.ComputeSha256(bytes);
            bool needWrite = true;
            if (File.Exists(targetPath))
            {
                try
                {
                    byte[] existing = File.ReadAllBytes(targetPath);
                    if (existing.Length == bytes.Length &&
                        string.Equals(SaveStore.ComputeSha256(existing), sourceSha, StringComparison.OrdinalIgnoreCase))
                    {
                        needWrite = false;
                    }
                }
                catch
                {
                    needWrite = true;
                }
            }
            if (needWrite)
            {
                File.WriteAllBytes(targetPath, bytes);
            }
        }

        private static void ExtractRuntimeLoader()
        {
            ExtractResourceIfChanged(LoaderResourceName, Path.Combine(RuntimeDir, LoaderResourceName));
        }

        private static void ExtractHtml()
        {
            ExtractResourceIfChanged(HtmlResourceName, HtmlPath);
        }

        private static void InitWebViewLoaderPath()
        {
            try
            {
                CoreWebView2Environment.SetLoaderDllFolderPath(RuntimeDir);
            }
            catch
            {
            }
        }

        internal static async Task<CoreWebView2> InitializeWebViewCoreAsync(
            WebView2 webView,
            EventHandler<CoreWebView2WebMessageReceivedEventArgs> webMessageHandler,
            EventHandler<CoreWebView2NavigationCompletedEventArgs> navCompletedHandler)
        {
            CoreWebView2Environment env = await CoreWebView2Environment.CreateAsync(null, WebView2UserDataDir, null);
            await webView.EnsureCoreWebView2Async(env);

            CoreWebView2 core = webView.CoreWebView2;
            if (core == null) return null;

            CoreWebView2Settings settings = core.Settings;
            if (settings != null)
            {
                settings.AreDevToolsEnabled = false;
                settings.AreDefaultContextMenusEnabled = false;
                settings.IsStatusBarEnabled = false;
                try { settings.AreHostObjectsAllowed = false; } catch { }
            }

            core.NavigationStarting += delegate(object sender, CoreWebView2NavigationStartingEventArgs e)
            {
                Uri uri;
                if (!Uri.TryCreate(e.Uri, UriKind.Absolute, out uri) ||
                    !string.Equals(uri.Scheme, "https", StringComparison.OrdinalIgnoreCase) ||
                    !string.Equals(uri.Host, VirtualHost, StringComparison.OrdinalIgnoreCase))
                {
                    e.Cancel = true;
                }
            };

            core.NewWindowRequested += delegate(object sender, CoreWebView2NewWindowRequestedEventArgs e)
            {
                e.Handled = true;
            };

            core.SetVirtualHostNameToFolderMapping(VirtualHost, HtmlDir, CoreWebView2HostResourceAccessKind.Deny);

            if (webMessageHandler != null) core.WebMessageReceived += webMessageHandler;
            if (navCompletedHandler != null) core.NavigationCompleted += navCompletedHandler;

            core.Navigate("https://" + VirtualHost + "/" + HtmlResourceName);
            return core;
        }
    }

    internal sealed class SaveEditorForm : Form
    {
        private readonly WebView2 _webView;

        internal SaveEditorForm()
        {
            Text = Program.AppTitle;
            ClientSize = new Size(1280, 840);
            MinimumSize = new Size(920, 640);
            StartPosition = FormStartPosition.CenterScreen;

            _webView = new WebView2();
            _webView.Dock = DockStyle.Fill;
            Controls.Add(_webView);

            Load += OnFormLoad;
        }

        private async void OnFormLoad(object sender, EventArgs e)
        {
            try
            {
                await Program.InitializeWebViewCoreAsync(_webView, OnWebMessageReceived, null);
            }
            catch (Exception ex)
            {
                MessageBox.Show(this, ex.Message, Program.AppTitle, MessageBoxButtons.OK, MessageBoxIcon.Error);
            }
        }

        private void OnWebMessageReceived(object sender, CoreWebView2WebMessageReceivedEventArgs e)
        {
            if (_webView != null && _webView.CoreWebView2 != null)
            {
                MessageDispatcher.HandleMessage(_webView.CoreWebView2, e);
            }
        }
    }

    internal static class MessageDispatcher
    {
        private static JavaScriptSerializer CreateSerializer()
        {
            JavaScriptSerializer ser = new JavaScriptSerializer();
            ser.MaxJsonLength = int.MaxValue;
            ser.RecursionLimit = int.MaxValue;
            return ser;
        }

        internal static void HandleMessage(CoreWebView2 core, CoreWebView2WebMessageReceivedEventArgs e)
        {
            JavaScriptSerializer ser = CreateSerializer();
            string reply;
            try
            {
                string rawJson = e.WebMessageAsJson;
                if (string.IsNullOrEmpty(rawJson)) rawJson = e.TryGetWebMessageAsString();
                Dictionary<string, object> req = ser.Deserialize<Dictionary<string, object>>(rawJson);
                string type = (req != null && req.ContainsKey("type") && req["type"] != null) ? Convert.ToString(req["type"]) : string.Empty;

                if (string.Equals(type, "discover", StringComparison.OrdinalIgnoreCase))
                {
                    List<object> list = new List<object>();
                    List<SaveSlotInfo> discovered = SaveStore.DiscoverSaves();
                    for (int i = 0; i < discovered.Count; i++)
                    {
                        SaveSlotInfo slot = discovered[i];
                        Dictionary<string, object> item = new Dictionary<string, object>();
                        item["path"] = slot.Path;
                        item["name"] = slot.Name;
                        item["isAuto"] = slot.IsAuto;
                        item["size"] = slot.Size;
                        item["modifiedUtc"] = slot.ModifiedUtc.ToString("yyyy-MM-ddTHH:mm:ssZ", CultureInfo.InvariantCulture);
                        item["sha256"] = slot.Sha256;
                        list.Add(item);
                    }
                    Dictionary<string, object> res = new Dictionary<string, object>();
                    res["type"] = "slots";
                    res["slots"] = list;
                    reply = ser.Serialize(res);
                }
                else if (string.Equals(type, "load", StringComparison.OrdinalIgnoreCase))
                {
                    string path = req.ContainsKey("path") ? Convert.ToString(req["path"]) : string.Empty;
                    SaveReadResult loaded = SaveStore.ReadSave(path);
                    Dictionary<string, object> res = new Dictionary<string, object>();
                    res["type"] = "loaded";
                    res["path"] = path;
                    res["dataBase64"] = Convert.ToBase64String(loaded.DataBytes);
                    res["sha256"] = loaded.Sha256;
                    reply = ser.Serialize(res);
                }
                else if (string.Equals(type, "save", StringComparison.OrdinalIgnoreCase))
                {
                    string path = req.ContainsKey("path") ? Convert.ToString(req["path"]) : string.Empty;
                    string dataB64 = req.ContainsKey("dataBase64") ? Convert.ToString(req["dataBase64"]) : string.Empty;
                    string expected = req.ContainsKey("expectedSha256") ? Convert.ToString(req["expectedSha256"]) : string.Empty;
                    byte[] bytes = Convert.FromBase64String(dataB64);
                    SaveResult saved = SaveStore.SaveWithBackup(path, bytes, expected);
                    Dictionary<string, object> res = new Dictionary<string, object>();
                    res["type"] = "saved";
                    res["path"] = path;
                    res["sha256"] = saved.NewSha256;
                    res["backupPath"] = saved.BackupPath;
                    res["success"] = saved.Success;
                    reply = ser.Serialize(res);
                }
                else
                {
                    Dictionary<string, object> err = new Dictionary<string, object>();
                    err["type"] = "error";
                    err["message"] = "Unknown message type: " + type;
                    reply = ser.Serialize(err);
                }
            }
            catch (Exception ex)
            {
                Dictionary<string, object> err = new Dictionary<string, object>();
                err["type"] = "error";
                err["message"] = ex.Message;
                reply = ser.Serialize(err);
            }

            try { core.PostWebMessageAsJson(reply); } catch { }
        }
    }

    internal static class SelfTestRunner
    {
        internal static int Run(string outDir, string seedSavePath)
        {
            Directory.CreateDirectory(outDir);
            string receiptPath = Path.Combine(outDir, "receipt.json");
            try { if (File.Exists(receiptPath)) File.Delete(receiptPath); } catch { }

            bool passed = false;
            Exception threadEx = null;
            ManualResetEventSlim done = new ManualResetEventSlim(false);
            SelfTestForm form = null;

            Thread sta = new Thread(delegate()
            {
                try
                {
                    Application.EnableVisualStyles();
                    Application.SetCompatibleTextRenderingDefault(false);
                    form = new SelfTestForm(outDir, seedSavePath, done);
                    Application.Run(form);
                    passed = form.Passed;
                }
                catch (Exception ex)
                {
                    threadEx = ex;
                    done.Set();
                }
            });
            sta.SetApartmentState(ApartmentState.STA);
            sta.IsBackground = true;
            sta.Start();

            if (!done.Wait(TimeSpan.FromSeconds(90)))
            {
                try
                {
                    if (form != null && form.IsHandleCreated)
                    {
                        form.BeginInvoke(new Action(delegate() { form.Close(); }));
                    }
                }
                catch { }
                WriteErrorReceipt(receiptPath, "self-test timed out");
                return 1;
            }

            sta.Join(TimeSpan.FromSeconds(10));
            if (threadEx != null)
            {
                WriteErrorReceipt(receiptPath, threadEx.Message);
                return 1;
            }
            return passed ? 0 : 1;
        }

        private static void WriteErrorReceipt(string receiptPath, string message)
        {
            try
            {
                if (File.Exists(receiptPath)) return;
                Dictionary<string, object> fail = new Dictionary<string, object>();
                fail["ok"] = false;
                fail["error"] = message;
                File.WriteAllText(receiptPath, new JavaScriptSerializer().Serialize(fail), new UTF8Encoding(false));
            }
            catch { }
        }
    }

    internal sealed class SelfTestForm : Form
    {
        private readonly string _outDir;
        private readonly string _seedSavePath;
        private readonly string _targetPath;
        private readonly ManualResetEventSlim _done;
        private WebView2 _webView;
        private CoreWebView2 _core;
        private bool _started;

        internal bool Passed { get; private set; }

        internal SelfTestForm(string outDir, string seedSavePath, ManualResetEventSlim done)
        {
            _outDir = outDir;
            _seedSavePath = seedSavePath;
            _done = done;
            _targetPath = Path.Combine(outDir, "selftest", "Save.sav");
            Directory.CreateDirectory(Path.GetDirectoryName(_targetPath));

            Opacity = 0.0;
            ShowInTaskbar = false;
            WindowState = FormWindowState.Minimized;
            StartPosition = FormStartPosition.Manual;
            Location = new Point(-32000, -32000);
            Size = new Size(1024, 720);
            Text = Program.AppTitle + " (self-test)";
        }

        protected override bool ShowWithoutActivation
        {
            get { return true; }
        }

        protected override async void OnLoad(EventArgs e)
        {
            base.OnLoad(e);
            _webView = new WebView2();
            _webView.Dock = DockStyle.Fill;
            Controls.Add(_webView);

            try
            {
                _core = await Program.InitializeWebViewCoreAsync(_webView, null, OnNavigationCompleted);
                if (_core == null)
                {
                    FinishFail("WebView2 core unavailable");
                }
            }
            catch (Exception ex)
            {
                FinishFail("WebView2 init error: " + ex.Message);
            }
        }

        private async void OnNavigationCompleted(object sender, CoreWebView2NavigationCompletedEventArgs e)
        {
            if (_started) return;
            _started = true;

            try
            {
                if (e == null || !e.IsSuccess)
                {
                    FinishFail("Navigation failed");
                    return;
                }

                string seedUsed;
                string initialSha;
                int hanziCount = 0;

                if (!string.IsNullOrEmpty(_seedSavePath) && File.Exists(_seedSavePath))
                {
                    seedUsed = _seedSavePath;
                    SaveReadResult seed = SaveStore.ReadSave(_seedSavePath);
                    File.WriteAllBytes(_targetPath, seed.DataBytes);
                    initialSha = seed.Sha256;
                    string b64 = Convert.ToBase64String(seed.DataBytes);
                    await _core.ExecuteScriptAsync("window.MyjhUi.loadFromBytes('" + b64 + "', { fileName: 'Save.sav', sha256: '" + seed.Sha256 + "', silent: true });");
                }
                else
                {
                    seedUsed = "demo";
                    await _core.ExecuteScriptAsync("window.MyjhUi.loadDemo();");
                    await Task.Delay(250);
                    string bodyRaw = await _core.ExecuteScriptAsync("document.body ? (document.body.innerText || '') : ''");
                    string bodyText = DecodeJsString(bodyRaw);
                    hanziCount = CountHanzi(bodyText);
                    if (hanziCount != 0)
                    {
                        FinishFail("Hanzi detected in rendered demo UI: " + hanziCount.ToString(CultureInfo.InvariantCulture));
                        return;
                    }

                    string initExportRaw = await _core.ExecuteScriptAsync("window.MyjhUi.exportBase64();");
                    byte[] initBytes = ExtractExportedBytes(initExportRaw);
                    File.WriteAllBytes(_targetPath, initBytes);
                    initialSha = SaveStore.ComputeSha256(initBytes);
                }

                await Task.Delay(150);
                await _core.ExecuteScriptAsync("window.MyjhUi.applyPreset('rich_resources');");
                await Task.Delay(150);

                string mutExportRaw = await _core.ExecuteScriptAsync("window.MyjhUi.exportBase64();");
                byte[] mutatedBytes = ExtractExportedBytes(mutExportRaw);

                SaveResult saveRes = SaveStore.SaveWithBackup(_targetPath, mutatedBytes, initialSha);
                bool backupExists = !string.IsNullOrEmpty(saveRes.BackupPath) && File.Exists(saveRes.BackupPath);
                byte[] diskBytes = File.ReadAllBytes(_targetPath);
                SaveStore.ValidateSaveBytes(diskBytes);

                uint silver = SaveStore.ReadSilverOrZero(diskBytes);
                bool currencyOk = silver >= 999999U;
                if (BitConverter.ToUInt32(diskBytes, SaveStore.HeaderSize) > 0U)
                {
                    uint coin = SaveStore.ReadCoinOrZero(diskBytes);
                    currencyOk = currencyOk && (coin >= 9999999U);
                }

                if (!saveRes.Success || !backupExists || !currencyOk)
                {
                    FinishFail("Post-save verification failed");
                    return;
                }

                Dictionary<string, object> receipt = new Dictionary<string, object>();
                receipt["ok"] = true;
                receipt["webview2Version"] = _core.Environment.BrowserVersionString;
                receipt["seedUsed"] = seedUsed;
                receipt["backupExists"] = backupExists;
                receipt["validateSaveBytes"] = true;
                receipt["currencyVerified"] = currencyOk;
                receipt["hanziCount"] = hanziCount;
                receipt["savedPath"] = _targetPath;
                receipt["backupPath"] = saveRes.BackupPath;
                receipt["initialSha256"] = initialSha;
                receipt["finalSha256"] = saveRes.NewSha256;

                JavaScriptSerializer ser = new JavaScriptSerializer();
                ser.MaxJsonLength = int.MaxValue;
                File.WriteAllText(Path.Combine(_outDir, "receipt.json"), ser.Serialize(receipt), new UTF8Encoding(false));
                Passed = true;
                _done.Set();
                Close();
            }
            catch (Exception ex)
            {
                FinishFail(ex.Message);
            }
        }

        private void FinishFail(string message)
        {
            Passed = false;
            try
            {
                Dictionary<string, object> receipt = new Dictionary<string, object>();
                receipt["ok"] = false;
                receipt["error"] = message;
                JavaScriptSerializer ser = new JavaScriptSerializer();
                File.WriteAllText(Path.Combine(_outDir, "receipt.json"), ser.Serialize(receipt), new UTF8Encoding(false));
            }
            catch { }
            _done.Set();
            try { Close(); } catch { }
        }

        private static string DecodeJsString(string rawJson)
        {
            if (string.IsNullOrEmpty(rawJson) || rawJson == "null") return string.Empty;
            JavaScriptSerializer ser = new JavaScriptSerializer();
            ser.MaxJsonLength = int.MaxValue;
            return ser.Deserialize<string>(rawJson) ?? string.Empty;
        }

        private static byte[] ExtractExportedBytes(string rawJson)
        {
            string inner = DecodeJsString(rawJson);
            JavaScriptSerializer ser = new JavaScriptSerializer();
            ser.MaxJsonLength = int.MaxValue;
            Dictionary<string, object> map = ser.Deserialize<Dictionary<string, object>>(inner);
            if (map == null || !map.ContainsKey("dataBase64"))
            {
                throw new InvalidDataException("exportBase64 missing dataBase64");
            }
            return Convert.FromBase64String(Convert.ToString(map["dataBase64"]));
        }

        private static int CountHanzi(string text)
        {
            if (string.IsNullOrEmpty(text)) return 0;
            int count = 0;
            for (int i = 0; i < text.Length; i++)
            {
                int cp = (int)text[i];
                if ((cp >= 0x4E00 && cp <= 0x9FFF) || (cp >= 0x3400 && cp <= 0x4DBF) || (cp >= 0xF900 && cp <= 0xFAFF))
                {
                    count++;
                }
            }
            return count;
        }
    }
}
