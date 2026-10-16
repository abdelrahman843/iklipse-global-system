using System;
using System.Threading;
using System.Windows.Forms;

namespace Iklipse
{
    static class Program
    {
        public const string AppUrl = "https://abdelrahman843.github.io/iklipse-global-system/";

        /// <summary>One iklipse at a time: opening it again brings the running one up.</summary>
        [STAThread]
        static void Main(string[] args)
        {
            using (var one = new Mutex(true, "iklipse-desktop", out bool first))
            {
                if (!first)
                {
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
                Application.Run(new MainForm(Array.IndexOf(args, "--hidden") >= 0));
            }
        }
    }
}
