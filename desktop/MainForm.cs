using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Runtime.InteropServices;
using System.Threading;
using System.Threading.Tasks;
using System.Web.Script.Serialization;
using System.Windows.Forms;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;
using Microsoft.Win32;

namespace Iklipse
{
    /// <summary>
    /// iklipse in a window (WebView2), kept running in the tray so notifications
    /// and Ikli's calls reach the computer with the window closed. The page talks
    /// to it with messages (src/lib/nativeApp.ts): "token" (for updates),
    /// "notify", "ring" (comes to the front, on top, while Ikli calls), "info".
    /// </summary>
    public class MainForm : Form
    {
        static readonly Color Background = Color.FromArgb(6, 8, 11);
        static readonly string Data = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "iklipse");
        static readonly Uri App = new Uri(Program.AppUrl);
        const string FilesHost = "larhrofldblegktowhdw.supabase.co";
        const string RunKey = @"Software\Microsoft\Windows\CurrentVersion\Run";

        readonly WebView2 web = new WebView2 { Dock = DockStyle.Fill, DefaultBackgroundColor = Background };
        readonly NotifyIcon tray = new NotifyIcon();
        readonly EventWaitHandle showSignal = new EventWaitHandle(false, EventResetMode.AutoReset, "iklipse-desktop-show");
        readonly JavaScriptSerializer json = new JavaScriptSerializer { MaxJsonLength = 8 * 1024 * 1024 };
        readonly Updater updater;
        bool allowShow;
        bool quitting;
        string balloonUrl;

        /// <summary>The signed-in person's login (the downloads are for the team only).</summary>
        public string Token { get; private set; }
        public bool Ringing { get; private set; }

        public MainForm(bool hidden)
        {
            allowShow = !hidden;
            Text = "iklipse";
            Icon = Icon.ExtractAssociatedIcon(Application.ExecutablePath);
            BackColor = Background;
            MinimumSize = new Size(420, 520);
            StartPosition = FormStartPosition.Manual;
            Bounds = SavedBounds();
            Controls.Add(web);

            var menu = new ContextMenuStrip();
            menu.Items.Add("Open iklipse", null, (s, e) => ShowMe(null));
            var atStart = new ToolStripMenuItem("Start with Windows") { Checked = StartsWithWindows() };
            atStart.Click += (s, e) => atStart.Checked = StartWithWindows(!atStart.Checked);
            menu.Items.Add(atStart);
            menu.Items.Add(new ToolStripSeparator());
            menu.Items.Add("Quit iklipse", null, (s, e) => Quit());
            tray.Icon = Icon;
            tray.Text = "iklipse";
            tray.ContextMenuStrip = menu;
            tray.Visible = true;
            tray.MouseClick += (s, e) =>
            {
                if (e.Button == MouseButtons.Left) ShowMe(null);
            };
            tray.BalloonTipClicked += (s, e) => ShowMe(balloonUrl);

            updater = new Updater(this);

            // Opened again (a second iklipse.exe): come up.
            new Thread(() =>
            {
                while (showSignal.WaitOne())
                {
                    try
                    {
                        BeginInvoke((Action)(() => ShowMe(null)));
                    }
                    catch (InvalidOperationException)
                    {
                        return;
                    }
                }
            }) { IsBackground = true }.Start();

            // The page loads even when it starts in the tray.
            CreateHandle();
            web.CreateControl();
            _ = Start();
        }

        protected override void SetVisibleCore(bool value)
        {
            base.SetVisibleCore(allowShow && value);
        }

        async Task Start()
        {
            // Pages behind a closed window keep running: calls and notifications still arrive.
            var flags = "--autoplay-policy=no-user-gesture-required --disable-background-timer-throttling --disable-renderer-backgrounding " +
                        "--disable-backgrounding-occluded-windows --disable-features=CalculateNativeWinOcclusion,IntensiveWakeUpThrottling";
            try
            {
                var env = await CoreWebView2Environment.CreateAsync(null, Path.Combine(Data, "WebView2"), new CoreWebView2EnvironmentOptions(flags));
                await web.EnsureCoreWebView2Async(env);
            }
            catch (WebView2RuntimeNotFoundException)
            {
                allowShow = true;
                MessageBox.Show("iklipse needs Microsoft Edge WebView2, which comes with Windows. Install it from the page that opens, then open iklipse again.",
                    "iklipse", MessageBoxButtons.OK, MessageBoxIcon.Information);
                OpenOutside("https://go.microsoft.com/fwlink/p/?LinkId=2124703");
                Quit();
                return;
            }

            var core = web.CoreWebView2;
            core.Settings.UserAgent += " iklipseApp/windows/" + Updater.Code;
            core.Settings.AreDevToolsEnabled = false;
            core.Settings.IsStatusBarEnabled = false;
            core.NavigationStarting += (s, e) =>
            {
                if (Allowed(e.Uri)) return;
                e.Cancel = true;
                OpenOutside(e.Uri);
            };
            core.NewWindowRequested += (s, e) =>
            {
                e.Handled = true;
                if (Allowed(e.Uri)) core.Navigate(e.Uri);
                else OpenOutside(e.Uri);
            };
            core.WebMessageReceived += OnMessage;
            core.ProcessFailed += (s, e) =>
            {
                if (e.ProcessFailedKind == CoreWebView2ProcessFailedKind.RenderProcessExited || e.ProcessFailedKind == CoreWebView2ProcessFailedKind.RenderProcessUnresponsive)
                    core.Reload();
            };
            core.Navigate(Program.AppUrl);
        }

        static bool Ours(Uri u) =>
            u.Scheme == "https" && u.Host == App.Host && u.AbsolutePath.StartsWith(App.AbsolutePath.TrimEnd('/'), StringComparison.Ordinal);

        /// <summary>iklipse's pages, and its files (they download here). Other sites open in the browser.</summary>
        static bool Allowed(string url)
        {
            if (url.StartsWith("about:", StringComparison.Ordinal) || url.StartsWith("data:", StringComparison.Ordinal) || url.StartsWith("blob:", StringComparison.Ordinal)) return true;
            if (!Uri.TryCreate(url, UriKind.Absolute, out var u)) return false;
            return Ours(u) || (u.Scheme == "https" && u.Host == FilesHost && u.AbsolutePath.Contains("/storage/v1/object/"));
        }

        static void OpenOutside(string url)
        {
            if (!Uri.TryCreate(url, UriKind.Absolute, out var u)) return;
            if (u.Scheme != "https" && u.Scheme != "http" && u.Scheme != "mailto" && u.Scheme != "tel" && u.Scheme != "whatsapp") return;
            try
            {
                Process.Start(new ProcessStartInfo(u.AbsoluteUri) { UseShellExecute = true });
            }
            catch
            {
                // no browser
            }
        }

        // ---------------------------------------------------------------- messages --

        void OnMessage(object sender, CoreWebView2WebMessageReceivedEventArgs e)
        {
            if (!Uri.TryCreate(e.Source, UriKind.Absolute, out var source) || !Ours(source)) return;
            Dictionary<string, object> m;
            try
            {
                m = json.Deserialize<Dictionary<string, object>>(e.WebMessageAsJson);
            }
            catch
            {
                return;
            }
            m.TryGetValue("id", out var id);
            switch (Str(m, "t"))
            {
                case "info":
                    Reply(id, new Dictionary<string, object> { ["platform"] = "windows", ["version"] = Updater.Name, ["code"] = Updater.Code });
                    break;
                case "token":
                    Token = Str(m, "token");
                    if (Token != null) updater.Soon();
                    break;
                case "ring":
                    Ring(m.TryGetValue("on", out var on) && on is bool b && b);
                    break;
                case "notify":
                    Notify(Str(m, "title") ?? "iklipse", Str(m, "body") ?? "", Str(m, "url"));
                    break;
                case "update":
                    updater.CheckNow();
                    break;
            }
        }

        static string Str(Dictionary<string, object> m, string key) => m.TryGetValue(key, out var v) ? v as string : null;

        void Reply(object id, Dictionary<string, object> answer)
        {
            answer["id"] = id;
            web.CoreWebView2?.PostWebMessageAsJson(json.Serialize(answer));
        }

        /// <summary>Ikli is calling: up front and on top until it stops ringing.</summary>
        void Ring(bool on)
        {
            if (on == Ringing) return;
            Ringing = on;
            if (on) ShowMe(null);
            TopMost = on;
            Flash(on);
        }

        /// <summary>A notification by the clock, unless iklipse is open in front of them.</summary>
        void Notify(string title, string body, string url)
        {
            if (Visible && ContainsFocus && WindowState != FormWindowState.Minimized) return;
            balloonUrl = url;
            tray.ShowBalloonTip(10_000, Cut(title, 63), Cut(string.IsNullOrWhiteSpace(body) ? "iklipse" : body, 255), ToolTipIcon.None);
        }

        static string Cut(string s, int n) => s.Length <= n ? s : s.Substring(0, n - 1) + "…";

        public void ShowMe(string url)
        {
            allowShow = true;
            if (!Visible) Show();
            if (WindowState == FormWindowState.Minimized) WindowState = FormWindowState.Normal;
            Activate();
            if (url != null && Uri.TryCreate(url, UriKind.Absolute, out var u) && Ours(u))
                web.CoreWebView2?.ExecuteScriptAsync("location.href=" + json.Serialize(u.AbsoluteUri));
        }

        // ---------------------------------------------------------------- window --

        protected override void OnFormClosing(FormClosingEventArgs e)
        {
            SaveBounds();
            if (!quitting && e.CloseReason == CloseReason.UserClosing)
            {
                // Closing the window keeps iklipse running in the tray.
                e.Cancel = true;
                Hide();
                var told = Path.Combine(Data, "told-tray");
                if (!File.Exists(told))
                {
                    Directory.CreateDirectory(Data);
                    File.WriteAllText(told, "1");
                    tray.ShowBalloonTip(8000, "iklipse is still on", "It keeps running here, so notifications and Ikli's calls reach you. Right-click this icon to quit.", ToolTipIcon.None);
                }
                return;
            }
            tray.Visible = false;
            base.OnFormClosing(e);
        }

        public void Quit()
        {
            quitting = true;
            tray.Visible = false;
            Application.Exit();
        }

        Rectangle SavedBounds()
        {
            try
            {
                var p = File.ReadAllText(Path.Combine(Data, "window")).Split(',');
                var r = new Rectangle(int.Parse(p[0]), int.Parse(p[1]), int.Parse(p[2]), int.Parse(p[3]));
                if (Screen.AllScreens is var all && Array.Exists(all, s => s.WorkingArea.IntersectsWith(r))) return r;
            }
            catch
            {
                // first run
            }
            var area = Screen.PrimaryScreen.WorkingArea;
            var w = Math.Min(1360, area.Width - 80);
            var h = Math.Min(860, area.Height - 80);
            return new Rectangle(area.Left + (area.Width - w) / 2, area.Top + (area.Height - h) / 2, w, h);
        }

        void SaveBounds()
        {
            if (!Visible || WindowState != FormWindowState.Normal) return;
            try
            {
                Directory.CreateDirectory(Data);
                File.WriteAllText(Path.Combine(Data, "window"), $"{Left},{Top},{Width},{Height}");
            }
            catch
            {
                // not important
            }
        }

        static bool StartsWithWindows()
        {
            using (var k = Registry.CurrentUser.OpenSubKey(RunKey)) return k?.GetValue("iklipse") != null;
        }

        static bool StartWithWindows(bool on)
        {
            using (var k = Registry.CurrentUser.CreateSubKey(RunKey))
            {
                if (on) k.SetValue("iklipse", $"\"{Application.ExecutablePath}\" --hidden");
                else k.DeleteValue("iklipse", false);
            }
            return on;
        }

        // Taskbar flashing while it rings.
        [StructLayout(LayoutKind.Sequential)]
        struct FLASHWINFO
        {
            public uint cbSize;
            public IntPtr hwnd;
            public uint dwFlags;
            public uint uCount;
            public uint dwTimeout;
        }

        [DllImport("user32.dll")]
        static extern bool FlashWindowEx(ref FLASHWINFO info);

        void Flash(bool on)
        {
            var f = new FLASHWINFO { cbSize = (uint)Marshal.SizeOf(typeof(FLASHWINFO)), hwnd = Handle, dwFlags = on ? 3u | 12u : 0u, uCount = uint.MaxValue };
            FlashWindowEx(ref f);
        }
    }
}
