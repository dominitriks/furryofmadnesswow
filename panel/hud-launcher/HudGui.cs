// AzerothCore HUD - native Windows GUI.
//
// No browser, no Electron: a plain WinForms window that polls the panel's REST
// API and draws the state with native controls. Built with the csc.exe that
// ships with Windows, so there is no SDK or runtime to install.
//
// It still needs the panel process (node server.js) for the API, and starts it
// automatically if the port is closed.

using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.Globalization;
using System.IO;
using System.Net;
using System.Net.Sockets;
using System.Text;
using System.Threading;
using System.Web.Script.Serialization;
using System.Windows.Forms;

static class Theme
{
    // Same palette as the web panel so the two do not disagree visually.
    public static readonly Color Plane   = ColorTranslator.FromHtml("#0d0d0d");
    public static readonly Color Surface = ColorTranslator.FromHtml("#1a1a19");
    public static readonly Color Ink     = ColorTranslator.FromHtml("#ffffff");
    public static readonly Color Ink2    = ColorTranslator.FromHtml("#c3c2b7");
    public static readonly Color Muted   = ColorTranslator.FromHtml("#898781");
    public static readonly Color Rule    = ColorTranslator.FromHtml("#2c2c2a");
    public static readonly Color Good    = ColorTranslator.FromHtml("#0ca30c");
    public static readonly Color Warn    = ColorTranslator.FromHtml("#fab219");
    public static readonly Color Crit    = ColorTranslator.FromHtml("#d03b3b");
    public static readonly Color Accent  = ColorTranslator.FromHtml("#3987e5");

    public static readonly Font H1    = new Font("Segoe UI", 14f, FontStyle.Bold);
    public static readonly Font Big   = new Font("Segoe UI", 26f, FontStyle.Bold);
    public static readonly Font Lbl   = new Font("Segoe UI", 8f,  FontStyle.Bold);
    public static readonly Font Body  = new Font("Segoe UI", 9.5f);
    public static readonly Font BodyB = new Font("Segoe UI", 9.5f, FontStyle.Bold);
    public static readonly Font Mono  = new Font("Consolas", 9f);
}

// A flat progress bar - WinForms' own ProgressBar cannot be recoloured reliably
// under the current visual styles.
class Bar : Control
{
    public double Value { get; set; }         // 0..1
    public Color Fill = Theme.Accent;
    public Bar() { Height = 7; DoubleBuffered = true; SetStyle(ControlStyles.ResizeRedraw, true); }
    protected override void OnPaint(PaintEventArgs e)
    {
        var g = e.Graphics;
        g.SmoothingMode = System.Drawing.Drawing2D.SmoothingMode.AntiAlias;
        using (var b = new SolidBrush(Theme.Plane)) g.FillRectangle(b, ClientRectangle);
        using (var p = new Pen(Theme.Rule)) g.DrawRectangle(p, 0, 0, Width - 1, Height - 1);
        int w = (int)Math.Round(Math.Max(0, Math.Min(1, Value)) * (Width - 2));
        if (w > 0) using (var b = new SolidBrush(Fill)) g.FillRectangle(b, 1, 1, w, Height - 2);
    }
}

class Card : Panel
{
    public Card(string title)
    {
        BackColor = Theme.Surface;
        Padding = new Padding(12, 10, 12, 12);
        var t = new Label
        {
            Text = title.ToUpperInvariant(), ForeColor = Theme.Muted, Font = Theme.Lbl,
            AutoSize = true, Location = new Point(12, 9)
        };
        Controls.Add(t);
    }
    protected override void OnPaint(PaintEventArgs e)
    {
        base.OnPaint(e);
        using (var p = new Pen(Color.FromArgb(28, 255, 255, 255)))
            e.Graphics.DrawRectangle(p, 0, 0, Width - 1, Height - 1);
    }
}

class Hud : Form
{
    const int PORT = 8080;
    const string BASE_URL  = "http://localhost:8080";
    const string PANEL_DIR = @"C:\Users\DomiJesusa\Desktop\wow\panel";

    readonly System.Windows.Forms.Timer timer = new System.Windows.Forms.Timer();
    readonly JavaScriptSerializer json = new JavaScriptSerializer();
    volatile bool busy;

    Label lState, lStamp, lAuth, lWorld, lSql;
    Label vPlayers, vBots, vTick, vTickNote, vRam, vRamNote;
    Bar   barTick, barRam;
    Label rAddr, rLocal, rName, rUp;
    Button bStart, bStop, bRestart, bPanel;
    TextBox tUser, tPass;
    ComboBox cLevel;
    Button bCreate;
    Label lLog;

    public Hud()
    {
        Text = "AzerothCore HUD";
        BackColor = Theme.Plane;
        ForeColor = Theme.Ink;
        Font = Theme.Body;
        StartPosition = FormStartPosition.CenterScreen;
        ClientSize = new Size(880, 660);
        MinimumSize = new Size(700, 560);

        BuildUi();

        timer.Interval = 3000;
        timer.Tick += (s, e) => Refresh_();
        timer.Start();

        Shown += (s, e) => { EnsurePanel(); Refresh_(); };
    }

    // ------------------------------------------------------------------ UI
    void BuildUi()
    {
        var head = new Label
        {
            Text = "AzerothCore", Font = Theme.H1, ForeColor = Theme.Ink,
            AutoSize = true, Location = new Point(16, 12)
        };
        Controls.Add(head);

        lStamp = new Label
        {
            Text = "зареждане…", Font = Theme.Body, ForeColor = Theme.Muted,
            AutoSize = true, Location = new Point(16, 38)
        };
        Controls.Add(lStamp);

        // --- services -----------------------------------------------------
        var cSvc = new Card("Състояние") { Location = new Point(16, 66), Size = new Size(270, 190) };
        lState = new Label { Font = Theme.Big, AutoSize = true, Location = new Point(12, 30), ForeColor = Theme.Muted, Text = "…" };
        cSvc.Controls.Add(lState);
        lAuth  = SvcRow(cSvc, "authserver 3724", 82);
        lWorld = SvcRow(cSvc, "worldserver 8085", 108);
        lSql   = SvcRow(cSvc, "MySQL 3306", 134);
        Controls.Add(cSvc);

        // --- players ------------------------------------------------------
        var cPl = new Card("Играчи в света") { Location = new Point(298, 66), Size = new Size(270, 190) };
        vPlayers = new Label { Font = Theme.Big, AutoSize = true, Location = new Point(12, 30), ForeColor = Theme.Ink, Text = "—" };
        vBots = new Label { Font = Theme.Body, AutoSize = true, Location = new Point(13, 78), ForeColor = Theme.Ink2, Text = "" };
        cPl.Controls.Add(vPlayers); cPl.Controls.Add(vBots);
        Controls.Add(cPl);

        // --- tick ---------------------------------------------------------
        var cTk = new Card("Tick (max)") { Location = new Point(580, 66), Size = new Size(270, 190) };
        vTick = new Label { Font = Theme.Big, AutoSize = true, Location = new Point(12, 30), ForeColor = Theme.Muted, Text = "—" };
        vTickNote = new Label { Font = Theme.BodyB, AutoSize = true, Location = new Point(13, 78), ForeColor = Theme.Muted, Text = "" };
        barTick = new Bar { Location = new Point(13, 104), Size = new Size(244, 7) };
        var tkHint = new Label { Font = Theme.Body, AutoSize = true, Location = new Point(13, 118), ForeColor = Theme.Muted,
                                 Text = "здрав ≤50 · натоварен <200 · над 200 спира ботове" , MaximumSize = new Size(244, 0) };
        cTk.Controls.Add(vTick); cTk.Controls.Add(vTickNote); cTk.Controls.Add(barTick); cTk.Controls.Add(tkHint);
        Controls.Add(cTk);

        // --- memory -------------------------------------------------------
        var cRam = new Card("Памет") { Location = new Point(16, 268), Size = new Size(270, 150) };
        vRam = new Label { Font = Theme.Big, AutoSize = true, Location = new Point(12, 30), ForeColor = Theme.Ink, Text = "—" };
        vRamNote = new Label { Font = Theme.BodyB, AutoSize = true, Location = new Point(13, 78), ForeColor = Theme.Muted, Text = "" };
        barRam = new Bar { Location = new Point(13, 104), Size = new Size(244, 7) };
        cRam.Controls.Add(vRam); cRam.Controls.Add(vRamNote); cRam.Controls.Add(barRam);
        Controls.Add(cRam);

        // --- realm --------------------------------------------------------
        var cRl = new Card("Realm") { Location = new Point(298, 268), Size = new Size(552, 150) };
        rAddr  = KvRow(cRl, "Адрес за клиента", 34);
        rLocal = KvRow(cRl, "LAN адрес", 60);
        rName  = KvRow(cRl, "Име · порт", 86);
        rUp    = KvRow(cRl, "worldserver uptime", 112);
        Controls.Add(cRl);

        // --- control ------------------------------------------------------
        var cCtl = new Card("Управление") { Location = new Point(16, 430), Size = new Size(400, 120) };
        bStart   = Btn(cCtl, "▶ Пусни",   12,  34, 92, Theme.Good, Color.Black);
        bStop    = Btn(cCtl, "■ Спри",   112,  34, 92, Theme.Crit, Color.White);
        bRestart = Btn(cCtl, "⟳ Рестарт", 212, 34, 92, Theme.Surface, Theme.Ink);
        bPanel   = Btn(cCtl, "Пълен панел", 12, 74, 192, Theme.Surface, Theme.Ink);
        bStart.Click   += (s, e) => ServerAction("start",   "Пускам сървъра…");
        bStop.Click    += (s, e) => { if (Ask("Да спра ли сървъра?")) ServerAction("stop", "Спирам сървъра…"); };
        bRestart.Click += (s, e) => { if (Ask("Да рестартирам ли сървъра?")) ServerAction("restart", "Рестартирам…"); };
        bPanel.Click   += (s, e) => { try { Process.Start(BASE_URL); } catch { } };
        Controls.Add(cCtl);

        // --- account ------------------------------------------------------
        var cAcc = new Card("Нов акаунт") { Location = new Point(428, 430), Size = new Size(422, 120) };
        tUser = Tb(cAcc, 12, 34, 150, "потребител");
        tPass = Tb(cAcc, 170, 34, 130, "парола");
        cLevel = new ComboBox
        {
            Location = new Point(12, 68), Size = new Size(288, 24), DropDownStyle = ComboBoxStyle.DropDownList,
            FlatStyle = FlatStyle.Flat, BackColor = Theme.Plane, ForeColor = Theme.Ink, Font = Theme.Body
        };
        cLevel.Items.AddRange(new object[] { "0 — Играч", "1 — Модератор", "2 — Game Master", "3 — Администратор" });
        cLevel.SelectedIndex = 0;
        cAcc.Controls.Add(cLevel);
        bCreate = Btn(cAcc, "Създай", 308, 34, 100, Theme.Accent, Color.Black);
        bCreate.Click += (s, e) => CreateAccount();
        cAcc.Controls.Add(bCreate);
        Controls.Add(cAcc);

        // --- log ----------------------------------------------------------
        lLog = new Label
        {
            Location = new Point(16, 562), Size = new Size(834, 60), ForeColor = Theme.Ink2,
            Font = Theme.Mono, Text = "", AutoEllipsis = true
        };
        Controls.Add(lLog);
    }

    Label SvcRow(Control parent, string name, int y)
    {
        var n = new Label { Text = name, ForeColor = Theme.Ink2, Font = Theme.Body, AutoSize = true, Location = new Point(13, y) };
        var v = new Label { Text = "…", ForeColor = Theme.Muted, Font = Theme.BodyB, AutoSize = true, Location = new Point(180, y) };
        parent.Controls.Add(n); parent.Controls.Add(v);
        return v;
    }
    Label KvRow(Control parent, string key, int y)
    {
        var k = new Label { Text = key, ForeColor = Theme.Muted, Font = Theme.Body, AutoSize = true, Location = new Point(13, y) };
        var v = new Label { Text = "—", ForeColor = Theme.Ink2, Font = Theme.BodyB, AutoSize = true, Location = new Point(190, y) };
        parent.Controls.Add(k); parent.Controls.Add(v);
        return v;
    }
    Button Btn(Control parent, string text, int x, int y, int w, Color bg, Color fg)
    {
        var b = new Button
        {
            Text = text, Location = new Point(x, y), Size = new Size(w, 30), FlatStyle = FlatStyle.Flat,
            BackColor = bg, ForeColor = fg, Font = Theme.BodyB, Cursor = Cursors.Hand
        };
        b.FlatAppearance.BorderColor = Theme.Rule;
        parent.Controls.Add(b);
        return b;
    }
    TextBox Tb(Control parent, int x, int y, int w, string placeholder)
    {
        var t = new TextBox
        {
            Location = new Point(x, y), Size = new Size(w, 24), BackColor = Theme.Plane, ForeColor = Theme.Ink,
            BorderStyle = BorderStyle.FixedSingle, Font = Theme.Body, MaxLength = 16
        };
        // .NET Framework TextBox has no placeholder; emulate one.
        t.Text = placeholder; t.ForeColor = Theme.Muted;
        t.GotFocus += (s, e) => { if (t.Text == placeholder) { t.Text = ""; t.ForeColor = Theme.Ink; } };
        t.LostFocus += (s, e) => { if (t.Text.Length == 0) { t.Text = placeholder; t.ForeColor = Theme.Muted; } };
        t.Tag = placeholder;
        parent.Controls.Add(t);
        return t;
    }
    string Val(TextBox t) { var ph = (string)t.Tag; return t.Text == ph ? "" : t.Text.Trim(); }
    bool Ask(string q) { return MessageBox.Show(q, "AzerothCore HUD", MessageBoxButtons.YesNo, MessageBoxIcon.Question) == DialogResult.Yes; }
    void Log(string s, Color c) { lLog.ForeColor = c; lLog.Text = s; }

    // --------------------------------------------------------------- panel
    static bool PortOpen()
    {
        try
        {
            using (var c = new TcpClient())
            {
                var ar = c.BeginConnect("127.0.0.1", PORT, null, null);
                if (!ar.AsyncWaitHandle.WaitOne(TimeSpan.FromMilliseconds(700))) return false;
                c.EndConnect(ar); return true;
            }
        }
        catch { return false; }
    }
    static string FindNode()
    {
        foreach (var p in new[] { @"C:\Program Files\nodejs\node.exe", @"C:\Program Files (x86)\nodejs\node.exe" })
            if (File.Exists(p)) return p;
        var env = Environment.GetEnvironmentVariable("PATH") ?? "";
        foreach (var d in env.Split(';'))
        {
            if (d.Length == 0) continue;
            try { var c = Path.Combine(d.Trim(), "node.exe"); if (File.Exists(c)) return c; } catch { }
        }
        return null;
    }
    void EnsurePanel()
    {
        if (PortOpen()) return;
        var node = FindNode();
        if (node == null) { Log("Node.js не е намерен — панелът не може да стартира.", Theme.Crit); return; }
        try
        {
            Process.Start(new ProcessStartInfo
            {
                FileName = node, Arguments = "server.js", WorkingDirectory = PANEL_DIR,
                UseShellExecute = false, CreateNoWindow = true
            });
            Log("Стартирам панела…", Theme.Ink2);
            for (int i = 0; i < 30 && !PortOpen(); i++) Thread.Sleep(400);
        }
        catch (Exception ex) { Log("Не мога да пусна панела: " + ex.Message, Theme.Crit); }
    }

    // ----------------------------------------------------------------- api
    string HttpGet(string path)
    {
        using (var wc = new WebClient())
        {
            wc.Encoding = Encoding.UTF8;
            return wc.DownloadString(BASE_URL + path);
        }
    }
    string HttpPost(string path, string body)
    {
        using (var wc = new WebClient())
        {
            wc.Encoding = Encoding.UTF8;
            wc.Headers[HttpRequestHeader.ContentType] = "application/json";
            return wc.UploadString(BASE_URL + path, "POST", body);
        }
    }
    static object Get(Dictionary<string, object> d, string k)
    {
        object v; return (d != null && d.TryGetValue(k, out v)) ? v : null;
    }
    static Dictionary<string, object> Obj(object o) { return o as Dictionary<string, object>; }
    static double Num(object o)
    {
        if (o == null) return double.NaN;
        try { return Convert.ToDouble(o, CultureInfo.InvariantCulture); } catch { return double.NaN; }
    }
    static bool Bool(object o) { return o is bool && (bool)o; }
    static string Str(object o) { return o == null ? "—" : o.ToString(); }

    // ------------------------------------------------------------- refresh
    void Refresh_()
    {
        if (busy) return;
        busy = true;
        var th = new Thread(() =>
        {
            string raw = null, err = null;
            try { raw = HttpGet("/api/status"); }
            catch (Exception ex) { err = ex.Message; }
            try
            {
                BeginInvoke((MethodInvoker)delegate
                {
                    if (err != null) { lStamp.Text = "няма връзка с панела: " + err; lState.Text = "—"; lState.ForeColor = Theme.Crit; }
                    else Apply(raw);
                    busy = false;
                });
            }
            catch { busy = false; }
        });
        th.IsBackground = true;
        th.Start();
    }

    void Apply(string raw)
    {
        var d = Obj(json.DeserializeObject(raw));
        if (d == null) return;

        var svc = Obj(Get(d, "services"));
        bool a = Bool(Get(svc, "authserver")), w = Bool(Get(svc, "worldserver")), m = Bool(Get(svc, "mysql"));
        SetSvc(lAuth, a); SetSvc(lWorld, w); SetSvc(lSql, m);

        bool all = a && w && m;
        lState.Text = all ? "ОНЛАЙН" : "ПРОБЛЕМ";
        lState.ForeColor = all ? Theme.Good : Theme.Crit;

        var counts = Obj(Get(d, "counts"));
        double players = Num(Get(d, "playersOnline"));
        if (double.IsNaN(players)) players = Num(Get(counts, "online"));
        double bots = Num(Get(d, "botsOnline"));
        double total = Num(Get(counts, "total"));
        vPlayers.Text = double.IsNaN(players) ? "—" : ((int)players).ToString();
        vBots.Text = string.Format("{0} бота онлайн · {1} характера общо",
            double.IsNaN(bots) ? 0 : (int)bots, double.IsNaN(total) ? 0 : (int)total);

        var perf = Obj(Get(d, "perf"));
        double mx = Num(Get(perf, "max")), p95 = Num(Get(perf, "p95"));
        if (double.IsNaN(mx)) { vTick.Text = "—"; vTick.ForeColor = Theme.Muted; vTickNote.Text = "няма данни"; vTickNote.ForeColor = Theme.Muted; barTick.Value = 0; }
        else
        {
            Color tc = mx >= 200 ? Theme.Crit : (mx >= 50 ? Theme.Warn : Theme.Good);
            vTick.Text = ((int)mx) + " ms"; vTick.ForeColor = tc;
            vTickNote.Text = (mx >= 200 ? "⚠ претоварен" : (mx >= 50 ? "⚠ натоварен" : "✓ здрав"))
                           + (double.IsNaN(p95) ? "" : "   p95 " + (int)p95 + " ms");
            vTickNote.ForeColor = tc;
            barTick.Value = Math.Min(1.0, mx / 300.0); barTick.Fill = tc; barTick.Invalidate();
        }

        var host = Obj(Get(d, "host"));
        double totMB = Num(Get(host, "totalMB")), freeMB = Num(Get(host, "freeMB"));
        var proc = Obj(Get(d, "proc"));
        var wsp = Obj(Get(proc, "worldserver"));
        if (!double.IsNaN(totMB) && totMB > 0)
        {
            int pct = (int)Math.Round((totMB - freeMB) / totMB * 100.0);
            Color rc = pct >= 90 ? Theme.Crit : (pct >= 75 ? Theme.Warn : Theme.Good);
            vRam.Text = pct + "%"; vRam.ForeColor = rc;
            vRamNote.Text = (pct >= 75 ? "⚠ " : "✓ ")
                          + (wsp != null ? "worldserver " + (int)Num(Get(wsp, "ramMB")) + " MB · " : "")
                          + "свободни " + (int)freeMB + " MB";
            vRamNote.ForeColor = rc;
            barRam.Value = pct / 100.0; barRam.Fill = rc; barRam.Invalidate();
        }

        var realm = Obj(Get(d, "realm"));
        rAddr.Text  = Str(Get(realm, "address"));
        rLocal.Text = Str(Get(realm, "localAddress"));
        rName.Text  = Str(Get(realm, "name")) + " · " + Str(Get(realm, "port"));
        double up = wsp != null ? Num(Get(wsp, "uptimeSec")) : double.NaN;
        rUp.Text = double.IsNaN(up) ? "—" : ((int)(up / 3600) + "ч " + (int)((up % 3600) / 60) + "м");

        bStart.Enabled = !w; bStop.Enabled = a || w; bRestart.Enabled = a || w;
        lStamp.Text = "обновено " + DateTime.Now.ToString("HH:mm:ss");
    }

    void SetSvc(Label l, bool ok)
    {
        // Icon + word, never colour alone.
        l.Text = ok ? "✓ работи" : "✗ СПРЯН";
        l.ForeColor = ok ? Theme.Good : Theme.Crit;
    }

    // ------------------------------------------------------------- actions
    void ServerAction(string action, string note)
    {
        Log(note + " (може да отнеме до 3 минути)", Theme.Ink2);
        SetButtons(false);
        var th = new Thread(() =>
        {
            string res, msg = null; bool ok = false;
            try
            {
                res = HttpPost("/api/server/" + action, "{}");
                var d = Obj(json.DeserializeObject(res));
                ok = Bool(Get(d, "ok")); msg = Str(Get(d, "msg"));
            }
            catch (Exception ex) { msg = ex.Message; }
            BeginInvoke((MethodInvoker)delegate
            {
                Log(msg, ok ? Theme.Good : Theme.Crit);
                SetButtons(true); Refresh_();
            });
        });
        th.IsBackground = true; th.Start();
    }

    void CreateAccount()
    {
        string u = Val(tUser), p = Val(tPass);
        int lvl = cLevel.SelectedIndex;
        if (u.Length == 0 || p.Length == 0) { Log("Попълни име и парола.", Theme.Warn); return; }

        Log("Създавам акаунт…", Theme.Ink2);
        SetButtons(false);
        string body = json.Serialize(new Dictionary<string, object> {
            { "username", u }, { "password", p }, { "gmlevel", lvl } });
        var th = new Thread(() =>
        {
            string msg = null; bool ok = false;
            try
            {
                var res = HttpPost("/api/account/create", body);
                var d = Obj(json.DeserializeObject(res));
                ok = Bool(Get(d, "ok")); msg = Str(Get(d, "msg"));
            }
            catch (WebException wex)
            {
                try { using (var r = new StreamReader(wex.Response.GetResponseStream()))
                      { var d = Obj(json.DeserializeObject(r.ReadToEnd())); msg = Str(Get(d, "msg")); } }
                catch { msg = wex.Message; }
            }
            catch (Exception ex) { msg = ex.Message; }
            BeginInvoke((MethodInvoker)delegate
            {
                Log(msg, ok ? Theme.Good : Theme.Crit);
                if (ok) { tUser.Text = (string)tUser.Tag; tUser.ForeColor = Theme.Muted;
                          tPass.Text = (string)tPass.Tag; tPass.ForeColor = Theme.Muted; }
                SetButtons(true); Refresh_();
            });
        });
        th.IsBackground = true; th.Start();
    }

    void SetButtons(bool on)
    {
        bStart.Enabled = on; bStop.Enabled = on; bRestart.Enabled = on; bCreate.Enabled = on;
    }

    [STAThread]
    static void Main()
    {
        Application.EnableVisualStyles();
        Application.SetCompatibleTextRenderingDefault(false);
        Application.Run(new Hud());
    }
}
