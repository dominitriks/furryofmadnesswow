// AzerothCore HUD launcher
//
// Double-click target that (1) makes sure the panel server is running and
// (2) opens the HUD in a chromeless browser window so it behaves like a normal
// desktop app rather than a browser tab.
//
// Built with the csc.exe that ships with Windows - no SDK, no toolchain, no
// runtime to install.

using System;
using System.Diagnostics;
using System.IO;
using System.Net.Sockets;
using System.Threading;
using System.Windows.Forms;

static class HudLauncher
{
    const int    PORT      = 8080;
    const string PANEL_DIR = @"C:\Users\DomiJesusa\Desktop\wow\panel";
    const string URL       = "http://localhost:8080/hud";

    static bool PortOpen()
    {
        try
        {
            using (var c = new TcpClient())
            {
                var ar = c.BeginConnect("127.0.0.1", PORT, null, null);
                if (!ar.AsyncWaitHandle.WaitOne(TimeSpan.FromMilliseconds(700)))
                    return false;
                c.EndConnect(ar);
                return true;
            }
        }
        catch { return false; }
    }

    static string FindNode()
    {
        string[] fixedPaths =
        {
            @"C:\Program Files\nodejs\node.exe",
            @"C:\Program Files (x86)\nodejs\node.exe",
        };
        foreach (var p in fixedPaths)
            if (File.Exists(p)) return p;

        // Fall back to PATH.
        var env = Environment.GetEnvironmentVariable("PATH") ?? "";
        foreach (var dir in env.Split(';'))
        {
            if (dir.Length == 0) continue;
            try
            {
                var cand = Path.Combine(dir.Trim(), "node.exe");
                if (File.Exists(cand)) return cand;
            }
            catch { }
        }
        return null;
    }

    static string FindBrowser()
    {
        string[] browsers =
        {
            @"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe",
            @"C:\Program Files\Microsoft\Edge\Application\msedge.exe",
            @"C:\Program Files\Google\Chrome\Application\chrome.exe",
            @"C:\Program Files (x86)\Google\Chrome\Application\chrome.exe",
        };
        foreach (var b in browsers)
            if (File.Exists(b)) return b;
        return null;
    }

    static bool StartPanel()
    {
        var node = FindNode();
        if (node == null)
        {
            MessageBox.Show(
                "Node.js не е намерен.\n\nТърсих в C:\\Program Files\\nodejs и в PATH.",
                "AzerothCore HUD", MessageBoxButtons.OK, MessageBoxIcon.Error);
            return false;
        }
        if (!File.Exists(Path.Combine(PANEL_DIR, "server.js")))
        {
            MessageBox.Show("Не намирам " + PANEL_DIR + "\\server.js",
                "AzerothCore HUD", MessageBoxButtons.OK, MessageBoxIcon.Error);
            return false;
        }

        var psi = new ProcessStartInfo
        {
            FileName         = node,
            Arguments        = "server.js",
            WorkingDirectory = PANEL_DIR,
            UseShellExecute  = false,
            CreateNoWindow   = true,
        };
        try { Process.Start(psi); }
        catch (Exception ex)
        {
            MessageBox.Show("Не мога да пусна панела:\n" + ex.Message,
                "AzerothCore HUD", MessageBoxButtons.OK, MessageBoxIcon.Error);
            return false;
        }

        // Give it up to ~20s to bind the port.
        for (int i = 0; i < 40; i++)
        {
            Thread.Sleep(500);
            if (PortOpen()) return true;
        }
        MessageBox.Show("Панелът не отговори на порт " + PORT + " за 20 секунди.\n\n" +
                        "Виж panel\\panel.err за причината.",
            "AzerothCore HUD", MessageBoxButtons.OK, MessageBoxIcon.Warning);
        return false;
    }

    [STAThread]
    static void Main()
    {
        if (!PortOpen() && !StartPanel())
            return;

        var browser = FindBrowser();
        if (browser == null)
        {
            // No Chromium browser - fall back to whatever handles http.
            try { Process.Start(URL); } catch { }
            return;
        }

        // A dedicated user-data-dir is what guarantees a real standalone window:
        // with the default profile an already-running Edge tends to hand the URL
        // to the existing session and open a tab instead.
        var profile = Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
            "AzerothCoreHud", "browser-profile");
        try { Directory.CreateDirectory(profile); } catch { }

        var args = "--app=" + URL +
                   " --user-data-dir=\"" + profile + "\"" +
                   " --window-size=1180,900" +
                   " --no-first-run --no-default-browser-check";

        try
        {
            Process.Start(new ProcessStartInfo
            {
                FileName        = browser,
                Arguments       = args,
                UseShellExecute = false,
            });
        }
        catch (Exception ex)
        {
            MessageBox.Show("Не мога да отворя прозореца:\n" + ex.Message,
                "AzerothCore HUD", MessageBoxButtons.OK, MessageBoxIcon.Error);
        }
    }
}
