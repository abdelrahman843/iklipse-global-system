using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Net.Http;
using System.Net.Http.Headers;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Text;
using System.Web.Script.Serialization;
using System.Windows.Forms;

namespace Iklipse
{
    /// <summary>
    /// Updates itself: asks iklipse for the newest Windows app (as the signed-in
    /// person, the downloads are team-only), downloads it, and installs it quietly
    /// when nobody is using iklipse (no call ringing, the window hidden or idle).
    /// The installer opens iklipse again.
    /// </summary>
    public class Updater
    {
        public static readonly int Code = Assembly.GetExecutingAssembly().GetName().Version.Build;
        public static readonly string Name = "1.0." + Code;
        const string Api = "https://larhrofldblegktowhdw.supabase.co/functions/v1/apps";

        readonly MainForm form;
        readonly Timer timer = new Timer { Interval = 60_000 };
        DateTime lastCheck = DateTime.MinValue;
        bool busy;
        string ready;

        public Updater(MainForm form)
        {
            this.form = form;
            timer.Tick += (s, e) => Tick();
            timer.Start();
            // Installers of versions already running.
            try
            {
                foreach (var f in Directory.GetFiles(Path.GetTempPath(), "iklipse-setup-*.exe")) File.Delete(f);
            }
            catch
            {
                // in use
            }
        }

        /// <summary>Just signed in: the first check.</summary>
        public void Soon()
        {
            if (lastCheck == DateTime.MinValue) CheckNow();
        }

        void Tick()
        {
            if (ready != null) TryInstall();
            else if ((DateTime.Now - lastCheck).TotalMinutes >= 60) CheckNow();
        }

        public async void CheckNow()
        {
            if (busy || form.Token == null) return;
            busy = true;
            lastCheck = DateTime.Now;
            try
            {
                Dictionary<string, object> m;
                using (var http = new HttpClient())
                {
                    http.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", form.Token);
                    var res = await http.PostAsync(Api, new StringContent("{\"platform\":\"windows\"}", Encoding.UTF8, "application/json"));
                    if (!res.IsSuccessStatusCode) return;
                    m = new JavaScriptSerializer().Deserialize<Dictionary<string, object>>(await res.Content.ReadAsStringAsync());
                }
                var code = Convert.ToInt32(m["code"]);
                var url = m["url"] as string;
                if (code <= Code || url == null) return;
                var path = Path.Combine(Path.GetTempPath(), $"iklipse-setup-{code}.exe");
                if (!File.Exists(path))
                {
                    using (var http = new HttpClient())
                    {
                        var bytes = await http.GetByteArrayAsync(url);
                        File.WriteAllBytes(path + ".part", bytes);
                    }
                    File.Move(path + ".part", path);
                }
                ready = path;
                TryInstall();
            }
            catch
            {
                // offline: the next hour
            }
            finally
            {
                busy = false;
            }
        }

        void TryInstall()
        {
            if (ready == null || form.Ringing) return;
            if (form.Visible && IdleSeconds() < 180) return;
            try
            {
                Process.Start(new ProcessStartInfo(ready, "/VERYSILENT /SUPPRESSMSGBOXES /NORESTART") { UseShellExecute = true });
                form.Quit();
            }
            catch
            {
                ready = null;
            }
        }

        [StructLayout(LayoutKind.Sequential)]
        struct LASTINPUTINFO
        {
            public uint cbSize;
            public uint dwTime;
        }

        [DllImport("user32.dll")]
        static extern bool GetLastInputInfo(ref LASTINPUTINFO info);

        static double IdleSeconds()
        {
            var i = new LASTINPUTINFO { cbSize = (uint)Marshal.SizeOf(typeof(LASTINPUTINFO)) };
            return GetLastInputInfo(ref i) ? (Environment.TickCount - (int)i.dwTime) / 1000.0 : 0;
        }
    }
}
