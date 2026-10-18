using System;
using System.IO;
using System.Threading;
using System.Windows.Forms;

namespace Iklipse
{
    static class Program
    {
        public const string AppUrl = "https://abdelrahman843.github.io/iklipse-global-system/";

        /// <summary>The page an iklipse:// link is for (null: not one of ours).</summary>
        public static string PageOf(string link)
        {
            if (link == null || !Uri.TryCreate(link, UriKind.Absolute, out var u) || u.Scheme != "iklipse" || u.Host != "back") return null;
            string to = null;
            foreach (var part in u.Query.TrimStart('?').Split('&'))
            {
                var kv = part.Split(new[] { '=' }, 2);
                if (kv.Length == 2 && kv[0] == "to") to = Uri.UnescapeDataString(kv[1].Replace('+', ' '));
            }
            if (to == null || !to.StartsWith("/") || to.StartsWith("//")) to = "/connections";
            return AppUrl + "#" + to;
        }

        /// <summary>
        /// One iklipse at a time: opening it again brings the running one up. An
        /// iklipse:// link (iklipse://back?to=/connections?calendly=connected, the way
        /// back after connecting an account in the browser) opens that page.
        /// </summary>
        [STAThread]
        static void Main(string[] args)
        {
            var link = Array.Find(args, a => a.StartsWith("iklipse:", StringComparison.OrdinalIgnoreCase));
            using (var one = new Mutex(true, "iklipse-desktop", out bool first))
            {
                if (!first)
                {
                    // The running one takes the page from a file, then comes up.
                    if (link != null)
                    {
                        try
                        {
                            Directory.CreateDirectory(MainForm.Data);
                            File.WriteAllText(MainForm.LinkFile, link);
                        }
                        catch
                        {
                            // it just comes up
                        }
                    }
                    try
                    {
                        using (var show = EventWaitHandle.OpenExisting("iklipse-desktop-show")) show.Set();
                    }
                    catch
                    {
                        // it's closing
                    }
                    return;
                }
                Application.EnableVisualStyles();
                Application.SetCompatibleTextRenderingDefault(false);
                // --hidden: started with Windows, straight to the tray.
                Application.Run(new MainForm(Array.IndexOf(args, "--hidden") >= 0 && link == null, PageOf(link)));
            }
        }
    }
}
