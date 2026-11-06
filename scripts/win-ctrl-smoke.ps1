# 윈도우에서 실제 콘솔 Ctrl+C / Ctrl+Break 로 postq 를 끝내 보고, 런처(node)·서버가 종료 코드 0 으로 끝나는지 본다.
# .github/workflows/ci.yml 의 install-smoke(windows) 가 부른다.
#
#   pwsh -File scripts/win-ctrl-smoke.ps1 -Launcher <npm root -g>\postq\bin\postq.js -Port 39251 -DataDir <폴더> -Event CtrlC
#
# 방법: 런처를 새 콘솔(CREATE_NEW_CONSOLE, 창 숨김)로 띄운다 → /api/health 200 을 기다린다 →
# 이 프로세스가 그 콘솔에 붙어(AttachConsole) GenerateConsoleCtrlEvent(이벤트, 0) 로 콘솔의 모든 프로세스(런처·서버)에
# 보낸다. 사람이 터미널에서 Ctrl+C 를 누른 것과 같은 경로다. 이 프로세스는 처리기를 걸어 두어 같이 죽지 않는다.
# (CREATE_NEW_PROCESS_GROUP 로 띄우면 그 그룹은 Ctrl+C 가 꺼진 채 시작해 Ctrl+C 를 시험할 수 없다.)
param(
  [Parameter(Mandatory)] [string] $Launcher,
  [Parameter(Mandatory)] [int] $Port,
  [Parameter(Mandatory)] [string] $DataDir,
  [ValidateSet('CtrlC', 'CtrlBreak')] [string] $Event = 'CtrlC',
  [int] $TimeoutSec = 20
)
$ErrorActionPreference = 'Stop'

Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Text;

public static class PqConsole {
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  struct STARTUPINFO {
    public int cb; public string lpReserved; public string lpDesktop; public string lpTitle;
    public int dwX, dwY, dwXSize, dwYSize, dwXCountChars, dwYCountChars, dwFillAttribute, dwFlags;
    public short wShowWindow, cbReserved2; public IntPtr lpReserved2, hStdInput, hStdOutput, hStdError;
  }
  [StructLayout(LayoutKind.Sequential)]
  struct PROCESS_INFORMATION { public IntPtr hProcess, hThread; public int dwProcessId, dwThreadId; }
  [StructLayout(LayoutKind.Sequential)]
  struct SECURITY_ATTRIBUTES { public int nLength; public IntPtr lpSecurityDescriptor; public bool bInheritHandle; }

  [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
  static extern bool CreateProcess(string app, StringBuilder cmd, IntPtr pa, IntPtr ta, bool inherit, uint flags,
    IntPtr env, string cwd, ref STARTUPINFO si, out PROCESS_INFORMATION pi);
  [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
  static extern IntPtr CreateFile(string name, uint access, uint share, ref SECURITY_ATTRIBUTES sa, uint disp, uint flags, IntPtr tmpl);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool CloseHandle(IntPtr h);
  [DllImport("kernel32.dll", SetLastError = true)] static extern uint WaitForSingleObject(IntPtr h, uint ms);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool GetExitCodeProcess(IntPtr h, out uint code);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool TerminateProcess(IntPtr h, uint code);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool FreeConsole();
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool AttachConsole(uint pid);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool GenerateConsoleCtrlEvent(uint ev, uint group);
  public delegate bool HandlerRoutine(uint ctrlType);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool SetConsoleCtrlHandler(HandlerRoutine h, bool add);

  // GC 가 걷어 가지 않게 붙들어 둔다.
  static readonly HandlerRoutine Swallow = t => true;
  static IntPtr proc = IntPtr.Zero;

  /// 새 콘솔(창 숨김)에서 띄우고 표준 출력·오류를 logPath 로. pid 를 돌려준다.
  public static int Start(string cmdLine, string logPath) {
    var sa = new SECURITY_ATTRIBUTES { nLength = Marshal.SizeOf(typeof(SECURITY_ATTRIBUTES)), bInheritHandle = true };
    IntPtr log = CreateFile(logPath, 0x40000000 /*GENERIC_WRITE*/, 3, ref sa, 2 /*CREATE_ALWAYS*/, 0x80, IntPtr.Zero);
    IntPtr nul = CreateFile("NUL", 0x80000000 /*GENERIC_READ*/, 3, ref sa, 3 /*OPEN_EXISTING*/, 0x80, IntPtr.Zero);
    if (log == new IntPtr(-1) || nul == new IntPtr(-1)) throw new Exception("CreateFile failed: " + Marshal.GetLastWin32Error());
    var si = new STARTUPINFO { cb = Marshal.SizeOf(typeof(STARTUPINFO)), dwFlags = 0x101 /*USESHOWWINDOW|USESTDHANDLES*/, wShowWindow = 0,
      hStdInput = nul, hStdOutput = log, hStdError = log };
    PROCESS_INFORMATION pi;
    // Ctrl+C 무시 상태(SetConsoleCtrlHandler(NULL, TRUE))는 자식에게 상속된다 — 러너 쪽 조상이 켜 두었으면
    // 런처·서버가 Ctrl+C 를 못 받아 거짓 실패가 난다. 띄우기 전에 끈다.
    SetConsoleCtrlHandler(null, false);
    if (!CreateProcess(null, new StringBuilder(cmdLine), IntPtr.Zero, IntPtr.Zero, true, 0x10 /*CREATE_NEW_CONSOLE*/,
        IntPtr.Zero, null, ref si, out pi))
      throw new Exception("CreateProcess failed: " + Marshal.GetLastWin32Error());
    CloseHandle(pi.hThread); CloseHandle(log); CloseHandle(nul);
    proc = pi.hProcess;
    return pi.dwProcessId;
  }

  /// pid 의 콘솔에 붙어 이벤트(0 = Ctrl+C, 1 = Ctrl+Break)를 보낸다. 실패하면 Win32 오류 코드, 성공하면 0.
  public static int Send(uint pid, uint ev) {
    FreeConsole();
    if (!AttachConsole(pid)) { int e = Marshal.GetLastWin32Error(); AttachConsole(0xFFFFFFFF); return e; }
    SetConsoleCtrlHandler(Swallow, true);
    int err = GenerateConsoleCtrlEvent(ev, 0) ? 0 : Marshal.GetLastWin32Error();
    System.Threading.Thread.Sleep(500); // 처리기가 우리 쪽에서도 돌고 끝나도록
    FreeConsole();
    AttachConsole(0xFFFFFFFF); // 원래(부모) 콘솔로 — 없으면 실패해도 그만
    return err;
  }

  /// 끝나기를 기다린다. 시간 안에 끝나면 종료 코드, 아니면 -1.
  public static long Wait(int ms) {
    if (WaitForSingleObject(proc, (uint)ms) != 0) return -1;
    uint code; GetExitCodeProcess(proc, out code); return code;
  }

  public static void Kill() { if (proc != IntPtr.Zero) TerminateProcess(proc, 99); }
}
'@

function Test-Health {
  try { (Invoke-WebRequest -UseBasicParsing -TimeoutSec 2 "http://127.0.0.1:$Port/api/health").StatusCode -eq 200 } catch { $false }
}

$node = (Get-Command node).Source
$log = Join-Path ([IO.Path]::GetTempPath()) "pq-ctrl-$Event-$Port.log"
$cmd = "`"$node`" `"$Launcher`" --no-open --port $Port --data-dir `"$DataDir`""
Write-Host "start: $cmd"
$launcherPid = [PqConsole]::Start($cmd, $log)
Write-Host "launcher pid $launcherPid"

$ok = $false
try {
  $up = $false
  for ($i = 0; $i -lt 60; $i++) { if (Test-Health) { $up = $true; break }; Start-Sleep -Milliseconds 500 }
  if (-not $up) { throw "server did not answer /api/health on $Port" }

  $ev = if ($Event -eq 'CtrlC') { 0 } else { 1 }
  $err = [PqConsole]::Send([uint32]$launcherPid, [uint32]$ev)
  if ($err -ne 0) { throw "could not send $Event (Win32 error $err)" }
  Write-Host "sent $Event"

  $code = [PqConsole]::Wait($TimeoutSec * 1000)
  if ($code -eq -1) { throw "launcher did not exit within $TimeoutSec s after $Event" }
  Write-Host "launcher exit code $code"
  if ($code -ne 0) { throw "launcher exited with $code after $Event (want 0)" }
  if (Test-Health) { throw "port $Port still answers after the launcher exited (server left behind)" }
  $text = Get-Content -Raw $log
  if ($text -notmatch 'stopping') { throw "server log has no 'stopping' — it did not see $Event" }
  $ok = $true
} finally {
  Write-Host "----- log -----"
  if (Test-Path $log) { Get-Content $log | Write-Host }
  if (-not $ok) {
    [PqConsole]::Kill()
    # 서버(자식)가 남았으면 이 포트를 쥔 프로세스만 정리한다.
    Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue |
      ForEach-Object { Stop-Process -Id $_.OwningProcess -Force -ErrorAction SilentlyContinue }
  }
}
Write-Host "$Event OK"
