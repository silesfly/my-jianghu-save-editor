using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Globalization;
using System.IO;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
using System.Threading;

namespace MyJianghuSaveEditor
{
    public sealed class SaveSlotInfo
    {
        public string Path { get; set; }
        public string Name { get; set; }
        public bool IsAuto { get; set; }
        public long Size { get; set; }
        public DateTime ModifiedUtc { get; set; }
        public string Sha256 { get; set; }

        public SaveSlotInfo()
        {
            Path = string.Empty;
            Name = string.Empty;
            Sha256 = string.Empty;
            ModifiedUtc = DateTime.MinValue;
        }
    }

    public sealed class SaveReadResult
    {
        public byte[] DataBytes { get; set; }
        public string Sha256 { get; set; }

        public SaveReadResult()
        {
            DataBytes = new byte[0];
            Sha256 = string.Empty;
        }
    }

    public sealed class SaveResult
    {
        public bool Success { get; set; }
        public string BackupPath { get; set; }
        public string NewSha256 { get; set; }

        public SaveResult()
        {
            BackupPath = string.Empty;
            NewSha256 = string.Empty;
        }
    }

    public static class SaveStore
    {
        public const string SimulateRunningVar = "MYJH_SIMULATE_GAME_RUNNING";
        public const string SaveDirEnvVar = "MYJH_SAVE_DIR";

        public const int MaxSaveBytes = 64 * 1024 * 1024;
        public const int HeaderSize = 0x2F8;
        public const int TableCount = 62;
        public const int MaxRecords = 500000;

        public static readonly int[] TableSizes = new int[62]
        {
            0x2280, 0x18, 0x20, 0x20, 0x20, 0x18, 0x38, 0x28, 0x80, 0x18,
            0x20, 0x20, 0x68, 0x350, 0x20, 0x20, 0x48, 0x18, 0x18, 0x28,
            0x48, 0x260, 0x120, 0x28, 0x60, 0x38, 0x270, 0x30, 0x38, 0x28,
            0x40, 0x20, 0x28, 0x20, 0x20, 0x168, 0x88, 0x138, 0x38, 0x48,
            0x30, 0x28, 0x28, 0x20, 0x20, 0x18, 0x28, 0x20, 0x20, 0x20,
            0x20, 0x2a0, 0x180, 0xb8, 0x30, 0x30, 0x28, 0x60, 0x30, 0xb8,
            0x320, 0x28
        };

        private const uint FILE_READ_ATTRIBUTES = 0x0080;
        private const uint FILE_SHARE_READ = 0x00000001;
        private const uint FILE_SHARE_WRITE = 0x00000002;
        private const uint FILE_SHARE_DELETE = 0x00000004;
        private const uint OPEN_EXISTING = 3;
        private const uint FILE_FLAG_OPEN_REPARSE_POINT = 0x00200000;
        private const uint FILE_FLAG_BACKUP_SEMANTICS = 0x02000000;
        private const uint MOVEFILE_REPLACE_EXISTING = 0x00000001;
        private const uint MOVEFILE_WRITE_THROUGH = 0x00000008;
        private const uint FILE_ATTRIBUTE_REPARSE_POINT = 0x00000400;
        private const int MAX_PATH = 260;
        private const int INVALID_HANDLE_VALUE = -1;

        [StructLayout(LayoutKind.Sequential)]
        private struct BY_HANDLE_FILE_INFORMATION
        {
            public uint FileAttributes;
            public System.Runtime.InteropServices.ComTypes.FILETIME CreationTime;
            public System.Runtime.InteropServices.ComTypes.FILETIME LastAccessTime;
            public System.Runtime.InteropServices.ComTypes.FILETIME LastWriteTime;
            public uint VolumeSerialNumber;
            public uint FileSizeHigh;
            public uint FileSizeLow;
            public uint NumberOfLinks;
            public uint FileIndexHigh;
            public uint FileIndexLow;
        }

        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        private static extern IntPtr CreateFileW(
            string lpFileName,
            uint dwDesiredAccess,
            uint dwShareMode,
            IntPtr lpSecurityAttributes,
            uint dwCreationDisposition,
            uint dwFlagsAndAttributes,
            IntPtr hTemplateFile);

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern bool GetFileInformationByHandle(
            IntPtr hFile,
            out BY_HANDLE_FILE_INFORMATION lpFileInformation);

        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        private static extern uint GetFinalPathNameByHandleW(
            IntPtr hFile,
            StringBuilder lpszFilePath,
            uint cchFilePath,
            uint dwFlags);

        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        private static extern bool MoveFileExW(
            string lpExistingFileName,
            string lpNewFileName,
            uint dwFlags);

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern bool CloseHandle(IntPtr hObject);

        public static bool HasInvalidColon(string path)
        {
            if (string.IsNullOrEmpty(path))
            {
                return false;
            }

            for (int i = 0; i < path.Length; i++)
            {
                if (path[i] == ':')
                {
                    bool drivePrefix = i == 1 &&
                        path.Length > 2 &&
                        ((path[0] >= 'A' && path[0] <= 'Z') || (path[0] >= 'a' && path[0] <= 'z')) &&
                        (path[2] == '\\' || path[2] == '/');

                    if (!drivePrefix)
                    {
                        return true;
                    }
                }
            }

            return false;
        }

        public static bool IsReservedDeviceName(string path)
        {
            if (string.IsNullOrEmpty(path))
            {
                return false;
            }

            string[] segments = path.Split(new char[] { '\\', '/', ':' });
            for (int i = 0; i < segments.Length; i++)
            {
                string seg = segments[i];
                if (string.IsNullOrEmpty(seg))
                {
                    continue;
                }
                int dot = seg.IndexOf('.');
                string stem = (dot >= 0 ? seg.Substring(0, dot) : seg).TrimEnd(' ').ToUpperInvariant();
                if (stem == "CON" || stem == "PRN" || stem == "AUX" || stem == "NUL")
                {
                    return true;
                }
                if (stem.Length == 4 &&
                    (stem.StartsWith("COM", StringComparison.Ordinal) || stem.StartsWith("LPT", StringComparison.Ordinal)) &&
                    stem[3] >= '1' && stem[3] <= '9')
                {
                    return true;
                }
            }

            return false;
        }

        public static void EnsureSafePath(string path)
        {
            if (string.IsNullOrEmpty(path))
            {
                throw new InvalidDataException("Path is empty.");
            }
            if (path.IndexOf('\0') >= 0 || HasInvalidColon(path) || IsReservedDeviceName(path))
            {
                throw new InvalidDataException("Unsafe path rejected.");
            }

            string full;
            try
            {
                full = Path.GetFullPath(path);
            }
            catch (Exception ex)
            {
                throw new InvalidDataException("Invalid path.", ex);
            }

            string root = Path.GetPathRoot(full);
            if (string.IsNullOrEmpty(root) || root.Length < 2 || root[1] != ':')
            {
                throw new InvalidDataException("Only local drive paths are supported.");
            }
            if (full.StartsWith("\\\\", StringComparison.Ordinal))
            {
                throw new InvalidDataException("UNC or device path rejected.");
            }
        }

        private static void EnsureSavePath(string savePath)
        {
            EnsureSafePath(savePath);
            string ext = Path.GetExtension(savePath);
            if (!string.Equals(ext, ".sav", StringComparison.OrdinalIgnoreCase))
            {
                throw new InvalidDataException("Save file must use .sav extension.");
            }
        }

        private static IntPtr OpenNoFollow(string path, bool directory)
        {
            uint flags = FILE_FLAG_OPEN_REPARSE_POINT;
            if (directory)
            {
                flags |= FILE_FLAG_BACKUP_SEMANTICS;
            }

            IntPtr handle = CreateFileW(
                path,
                FILE_READ_ATTRIBUTES,
                FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
                IntPtr.Zero,
                OPEN_EXISTING,
                flags,
                IntPtr.Zero);

            if (handle == IntPtr.Zero || handle == new IntPtr(INVALID_HANDLE_VALUE))
            {
                throw new InvalidDataException("Unable to open path handle: " + path +
                    " (Win32 error " + Marshal.GetLastWin32Error().ToString(CultureInfo.InvariantCulture) + ")");
            }

            return handle;
        }

        private static void InspectHandle(IntPtr handle, string path, bool rejectHardLinks)
        {
            BY_HANDLE_FILE_INFORMATION info;
            if (!GetFileInformationByHandle(handle, out info))
            {
                throw new InvalidDataException("Unable to inspect handle: " + path);
            }
            if ((info.FileAttributes & FILE_ATTRIBUTE_REPARSE_POINT) != 0)
            {
                throw new InvalidDataException("Reparse point rejected: " + path);
            }
            if (rejectHardLinks && info.NumberOfLinks > 1)
            {
                throw new InvalidDataException("Hard-linked file rejected: " + path);
            }

            StringBuilder sb = new StringBuilder(MAX_PATH);
            uint len = GetFinalPathNameByHandleW(handle, sb, (uint)sb.Capacity, 0);
            if (len >= sb.Capacity)
            {
                sb = new StringBuilder((int)len + 2);
                len = GetFinalPathNameByHandleW(handle, sb, (uint)sb.Capacity, 0);
            }
            if (len == 0 || len >= sb.Capacity)
            {
                throw new InvalidDataException("Unable to resolve final path: " + path);
            }
            string finalPath = sb.ToString();
            if (finalPath.StartsWith("\\\\?\\UNC\\", StringComparison.OrdinalIgnoreCase) ||
                finalPath.StartsWith("\\\\.\\", StringComparison.Ordinal))
            {
                throw new InvalidDataException("Unsafe final path rejected: " + finalPath);
            }
        }

        public static void NoLinks(string path)
        {
            EnsureSafePath(path);
            string full = Path.GetFullPath(path);
            string root = Path.GetPathRoot(full);
            List<IntPtr> pinned = new List<IntPtr>();
            try
            {
                IntPtr rootHandle = OpenNoFollow(root, true);
                pinned.Add(rootHandle);
                InspectHandle(rootHandle, root, false);

                string current = root;
                string rest = full.Substring(root.Length);
                string[] parts = rest.Split(new char[] { Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar }, StringSplitOptions.RemoveEmptyEntries);
                for (int i = 0; i < parts.Length - 1; i++)
                {
                    current = Path.Combine(current, parts[i]);
                    IntPtr dirHandle = OpenNoFollow(current, true);
                    pinned.Add(dirHandle);
                    InspectHandle(dirHandle, current, false);
                }

                bool isDir = Directory.Exists(full);
                IntPtr leaf = OpenNoFollow(full, isDir);
                pinned.Add(leaf);
                InspectHandle(leaf, full, !isDir);
            }
            finally
            {
                for (int i = 0; i < pinned.Count; i++)
                {
                    if (pinned[i] != IntPtr.Zero && pinned[i] != new IntPtr(INVALID_HANDLE_VALUE))
                    {
                        CloseHandle(pinned[i]);
                    }
                }
            }
        }

        public static void ValidateSaveBytes(byte[] data)
        {
            if (data == null)
            {
                throw new InvalidDataException("Save data is null.");
            }
            if (data.Length > MaxSaveBytes)
            {
                throw new InvalidDataException("Save data exceeds maximum allowed size.");
            }
            long minimum = (long)HeaderSize + ((long)TableCount * 4L);
            if ((long)data.Length < minimum)
            {
                throw new InvalidDataException("Save data is smaller than minimum header length.");
            }

            long off = HeaderSize;
            for (int i = 0; i < TableCount; i++)
            {
                if (off + 4L > data.Length)
                {
                    throw new InvalidDataException("Table count truncated.");
                }
                uint count = BitConverter.ToUInt32(data, (int)off);
                off += 4L;
                if (count > (uint)MaxRecords)
                {
                    throw new InvalidDataException("Table record count exceeds limit.");
                }
                long bodyBytes = (long)count * (long)TableSizes[i];
                if (off + bodyBytes > data.Length)
                {
                    throw new InvalidDataException("Table body truncated.");
                }
                off += bodyBytes;
            }

            if (off != data.Length)
            {
                throw new InvalidDataException("Unexpected trailing bytes in save data.");
            }
        }

        public static uint ReadCoinOrZero(byte[] data)
        {
            ValidateSaveBytes(data);
            uint count = BitConverter.ToUInt32(data, HeaderSize);
            if (count == 0)
            {
                return 0;
            }
            return BitConverter.ToUInt32(data, HeaderSize + 4 + 0x38);
        }

        public static uint ReadSilverOrZero(byte[] data)
        {
            ValidateSaveBytes(data);
            int off = HeaderSize;
            for (int i = 0; i < TableCount; i++)
            {
                uint count = BitConverter.ToUInt32(data, off);
                off += 4;
                int sz = TableSizes[i];
                if (i == TableCount - 1)
                {
                    for (uint r = 0; r < count; r++)
                    {
                        int rec = off + ((int)r * sz);
                        uint key = BitConverter.ToUInt32(data, rec + 0x10);
                        uint funcType = BitConverter.ToUInt32(data, rec + 0x14);
                        if (key == 2 && funcType == 2)
                        {
                            return BitConverter.ToUInt32(data, rec + 0x18);
                        }
                    }
                }
                off += (int)count * sz;
            }
            return 0;
        }

        public static bool IsGameRunning()
        {
            string sim = Environment.GetEnvironmentVariable(SimulateRunningVar);
            if (!string.IsNullOrEmpty(sim))
            {
                string trimmed = sim.Trim();
                if (string.Equals(trimmed, "1", StringComparison.OrdinalIgnoreCase) ||
                    string.Equals(trimmed, "true", StringComparison.OrdinalIgnoreCase) ||
                    string.Equals(trimmed, "yes", StringComparison.OrdinalIgnoreCase))
                {
                    return true;
                }
            }

            try
            {
                Process[] procs = Process.GetProcesses();
                for (int i = 0; i < procs.Length; i++)
                {
                    try
                    {
                        if (string.Equals(procs[i].ProcessName, "DreamRivakes", StringComparison.OrdinalIgnoreCase))
                        {
                            return true;
                        }
                    }
                    catch
                    {
                    }
                    finally
                    {
                        procs[i].Dispose();
                    }
                }
            }
            catch
            {
            }
            return false;
        }

        public static List<SaveSlotInfo> DiscoverSaves()
        {
            return DiscoverSaves(null);
        }

        public static List<SaveSlotInfo> DiscoverSaves(string explicitDir)
        {
            List<SaveSlotInfo> results = new List<SaveSlotInfo>();
            List<string> gameRoots = new List<string>();

            AddCandidateDir(gameRoots, explicitDir);
            AddCandidateDir(gameRoots, Environment.GetEnvironmentVariable(SaveDirEnvVar));

            List<string> steamRoots = new List<string>();
            AddSteamRoot(steamRoots, Combine2(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFilesX86), "Steam"));
            AddSteamRoot(steamRoots, Combine2(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles), "Steam"));
            for (int i = 0; i < steamRoots.Count; i++)
            {
                AddCandidateDir(gameRoots, Combine2(Combine2(steamRoots[i], "steamapps"), "common\\xiake"));
            }

            for (int g = 0; g < gameRoots.Count; g++)
            {
                string root = gameRoots[g];
                if (!Directory.Exists(root))
                {
                    continue;
                }

                AddDiscovered(results, Combine2(root, "Save.sav"), true, null);

                string saveFileDir = Combine2(root, "SaveFile");
                if (Directory.Exists(saveFileDir))
                {
                    string[] subs = null;
                    try { subs = Directory.GetDirectories(saveFileDir); } catch { }
                    if (subs != null)
                    {
                        Array.Sort(subs, StringComparer.OrdinalIgnoreCase);
                        for (int i = 0; i < subs.Length; i++)
                        {
                            string subName = Path.GetFileName(subs[i]);
                            AddDiscovered(results, Combine2(subs[i], "Save.sav"), false, subName);
                        }
                    }
                }
            }

            return results;
        }

        private static void AddCandidateDir(List<string> list, string dir)
        {
            if (string.IsNullOrEmpty(dir))
            {
                return;
            }
            string full;
            try { full = Path.GetFullPath(dir); } catch { return; }
            for (int i = 0; i < list.Count; i++)
            {
                if (string.Equals(list[i], full, StringComparison.OrdinalIgnoreCase))
                {
                    return;
                }
            }
            list.Add(full);
        }

        private static void AddSteamRoot(List<string> steamRoots, string root)
        {
            if (string.IsNullOrEmpty(root) || !Directory.Exists(root))
            {
                return;
            }
            AddCandidateDir(steamRoots, root);

            string vdf = Combine2(Combine2(root, "steamapps"), "libraryfolders.vdf");
            if (!File.Exists(vdf))
            {
                return;
            }

            string[] lines = null;
            try { lines = File.ReadAllLines(vdf); } catch { return; }
            for (int i = 0; i < lines.Length; i++)
            {
                string line = lines[i].Trim();
                int key = line.IndexOf("\"path\"", StringComparison.OrdinalIgnoreCase);
                if (key < 0) continue;
                int q1 = line.IndexOf('"', key + 6);
                if (q1 < 0) continue;
                int q2 = line.IndexOf('"', q1 + 1);
                if (q2 < 0) continue;
                string p = line.Substring(q1 + 1, q2 - q1 - 1).Replace("\\\\", "\\");
                AddCandidateDir(steamRoots, p);
            }
        }

        private static void AddDiscovered(List<SaveSlotInfo> results, string path, bool isAuto, string subName)
        {
            if (string.IsNullOrEmpty(path) || !File.Exists(path))
            {
                return;
            }
            for (int i = 0; i < results.Count; i++)
            {
                if (string.Equals(results[i].Path, path, StringComparison.OrdinalIgnoreCase))
                {
                    return;
                }
            }
            try
            {
                EnsureSavePath(path);
                NoLinks(path);
                byte[] bytes = File.ReadAllBytes(path);
                ValidateSaveBytes(bytes);
                SaveSlotInfo info = new SaveSlotInfo();
                info.Path = path;
                info.Name = isAuto ? "\uc790\ub3d9 \uc800\uc7a5 (Save.sav)" : "\uc2ac\ub86f " + subName + " (Save.sav)";
                info.IsAuto = isAuto;
                info.Size = bytes.Length;
                info.ModifiedUtc = File.GetLastWriteTimeUtc(path);
                info.Sha256 = ComputeSha256(bytes);
                results.Add(info);
            }
            catch
            {
            }
        }

        public static SaveReadResult ReadSave(string savePath)
        {
            EnsureSavePath(savePath);
            NoLinks(savePath);
            byte[] bytes = File.ReadAllBytes(savePath);
            ValidateSaveBytes(bytes);

            SaveReadResult res = new SaveReadResult();
            res.DataBytes = bytes;
            res.Sha256 = ComputeSha256(bytes);
            return res;
        }

        private static FileStream AcquireSlotLock(string savePath)
        {
            string lockPath = savePath + ".lock";
            EnsureSafePath(lockPath);
            if (File.Exists(lockPath))
            {
                NoLinks(lockPath);
            }

            IOException lastEx = null;
            for (int attempt = 0; attempt < 120; attempt++)
            {
                try
                {
                    FileStream fs = new FileStream(lockPath, FileMode.OpenOrCreate, FileAccess.ReadWrite, FileShare.None);
                    try
                    {
                        NoLinks(lockPath);
                    }
                    catch
                    {
                        fs.Dispose();
                        throw;
                    }
                    return fs;
                }
                catch (IOException ex)
                {
                    lastEx = ex;
                    Thread.Sleep(25);
                }
            }
            throw new IOException("Timed out acquiring per-slot save lock.", lastEx);
        }

        public static SaveResult SaveWithBackup(string savePath, byte[] newBytes, string expectedSha256)
        {
            if (IsGameRunning())
            {
                throw new IOException("Game process DreamRivakes is running; refusing to overwrite save.");
            }
            EnsureSavePath(savePath);
            NoLinks(savePath);
            ValidateSaveBytes(newBytes);

            using (FileStream slotLock = AcquireSlotLock(savePath))
            {
                if (IsGameRunning())
                {
                    throw new IOException("Game process DreamRivakes is running; refusing to overwrite save.");
                }
                NoLinks(savePath);
                byte[] oldBytes = File.ReadAllBytes(savePath);
                string oldSha = ComputeSha256(oldBytes);
                if (!string.IsNullOrEmpty(expectedSha256) &&
                    !string.Equals(oldSha, expectedSha256, StringComparison.OrdinalIgnoreCase))
                {
                    throw new InvalidDataException("Save file changed on disk (SHA-256 mismatch).");
                }

                string stamp = DateTime.UtcNow.ToString("yyyyMMddTHHmmssZ", CultureInfo.InvariantCulture);
                string pid = Process.GetCurrentProcess().Id.ToString(CultureInfo.InvariantCulture);
                string rand = NewRandomHex(8);
                string backup = savePath + ".backup-" + stamp + "-" + pid + "-" + rand + ".bak";

                File.Copy(savePath, backup, false);
                string backupSha = ComputeSha256(File.ReadAllBytes(backup));
                if (!string.Equals(backupSha, oldSha, StringComparison.OrdinalIgnoreCase))
                {
                    try { File.Delete(backup); } catch { }
                    throw new IOException("Backup SHA-256 verification failed.");
                }

                string pending = savePath + ".pending-" + pid + "-" + NewRandomHex(8) + ".tmp";
                try
                {
                    using (FileStream fs = new FileStream(pending, FileMode.CreateNew, FileAccess.Write, FileShare.None))
                    {
                        fs.Write(newBytes, 0, newBytes.Length);
                        fs.Flush(true);
                    }
                    if (!MoveFileExW(pending, savePath, MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH))
                    {
                        throw new IOException("Atomic MoveFileExW failed (Win32 error " +
                            Marshal.GetLastWin32Error().ToString(CultureInfo.InvariantCulture) + ").");
                    }
                }
                catch
                {
                    try { if (File.Exists(pending)) File.Delete(pending); } catch { }
                    throw;
                }

                SaveResult result = new SaveResult();
                result.Success = true;
                result.BackupPath = backup;
                result.NewSha256 = ComputeSha256(newBytes);
                return result;
            }
        }

        private static string NewRandomHex(int bytesLen)
        {
            byte[] raw = new byte[bytesLen];
            using (RandomNumberGenerator rng = RandomNumberGenerator.Create())
            {
                rng.GetBytes(raw);
            }
            StringBuilder sb = new StringBuilder(raw.Length * 2);
            for (int i = 0; i < raw.Length; i++)
            {
                sb.Append(raw[i].ToString("x2", CultureInfo.InvariantCulture));
            }
            return sb.ToString();
        }

        public static string ComputeSha256(byte[] bytes)
        {
            if (bytes == null)
            {
                throw new ArgumentNullException("bytes");
            }
            using (SHA256 sha = SHA256.Create())
            {
                byte[] hash = sha.ComputeHash(bytes);
                StringBuilder sb = new StringBuilder(hash.Length * 2);
                for (int i = 0; i < hash.Length; i++)
                {
                    sb.Append(hash[i].ToString("x2", CultureInfo.InvariantCulture));
                }
                return sb.ToString();
            }
        }

        private static string Combine2(string a, string b)
        {
            if (string.IsNullOrEmpty(a)) return b;
            if (string.IsNullOrEmpty(b)) return a;
            return Path.Combine(a, b);
        }
    }
}
