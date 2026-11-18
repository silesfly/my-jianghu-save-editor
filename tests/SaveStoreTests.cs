using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;

namespace MyJianghuSaveEditor
{
    internal static class SaveStoreTests
    {
        private static int _passed;
        private static int _failed;

        private static void AssertTrue(bool condition, string name)
        {
            if (condition)
            {
                _passed++;
                Console.WriteLine("PASS: " + name);
            }
            else
            {
                _failed++;
                Console.WriteLine("FAIL: " + name);
            }
        }

        private static void AssertBytesEqual(byte[] expected, byte[] actual, string name)
        {
            bool ok = expected != null && actual != null && expected.Length == actual.Length;
            if (ok)
            {
                for (int i = 0; i < expected.Length; i++)
                {
                    if (expected[i] != actual[i])
                    {
                        ok = false;
                        break;
                    }
                }
            }
            AssertTrue(ok, name);
        }

        private static void AssertThrows<T>(Action action, string name) where T : Exception
        {
            bool ok = false;
            try
            {
                action();
            }
            catch (T)
            {
                ok = true;
            }
            catch (Exception ex)
            {
                Console.WriteLine("Unexpected exception for " + name + ": " + ex.GetType().Name + " - " + ex.Message);
            }
            AssertTrue(ok, name);
        }

        private static void WriteUInt32LE(byte[] bytes, int offset, uint value)
        {
            bytes[offset] = (byte)(value & 0xFF);
            bytes[offset + 1] = (byte)((value >> 8) & 0xFF);
            bytes[offset + 2] = (byte)((value >> 16) & 0xFF);
            bytes[offset + 3] = (byte)((value >> 24) & 0xFF);
        }

        private static byte[] BuildSyntheticSave(uint coin, uint silver, bool includeT00)
        {
            int count = SaveStore.TableCount;
            int headerSize = SaveStore.HeaderSize;
            int[] sizes = SaveStore.TableSizes;

            int total = headerSize + (count * 4) + (includeT00 ? sizes[0] : 0) + sizes[61];
            byte[] bytes = new byte[total];
            int pos = headerSize;

            for (int i = 0; i < count; i++)
            {
                if (i == 0 && includeT00)
                {
                    WriteUInt32LE(bytes, pos, 1U);
                    pos += 4;
                    WriteUInt32LE(bytes, pos + 0x10, 2U);
                    WriteUInt32LE(bytes, pos + 0x14, 8U);
                    WriteUInt32LE(bytes, pos + 0x38, coin);
                    pos += sizes[0];
                }
                else if (i == 61)
                {
                    WriteUInt32LE(bytes, pos, 1U);
                    pos += 4;
                    WriteUInt32LE(bytes, pos + 0x10, 2U);
                    WriteUInt32LE(bytes, pos + 0x14, 2U);
                    WriteUInt32LE(bytes, pos + 0x18, silver);
                    pos += sizes[61];
                }
                else
                {
                    WriteUInt32LE(bytes, pos, 0U);
                    pos += 4;
                }
            }
            return bytes;
        }

        private static string MakeTempDir()
        {
            string dir = Path.Combine(Path.GetTempPath(), "MyjhStoreTests_" + Guid.NewGuid().ToString("N"));
            Directory.CreateDirectory(dir);
            return dir;
        }

        private static void DeleteDirQuiet(string dir)
        {
            try
            {
                if (Directory.Exists(dir))
                {
                    Directory.Delete(dir, true);
                }
            }
            catch
            {
            }
        }

        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        private static extern bool CreateHardLinkW(string lpFileName, string lpExistingFileName, IntPtr lpSecurityAttributes);

        public static int Main()
        {
            try
            {
                RunPathTests();
                RunBinaryTests();
                RunDiscoveryAndSaveTests();
            }
            catch (Exception ex)
            {
                _failed++;
                Console.WriteLine("FAIL: unhandled " + ex.GetType().FullName + " " + ex.Message);
            }

            int total = _passed + _failed;
            Console.WriteLine("PASS: " + _passed + "/" + total);
            return _failed == 0 ? 0 : 1;
        }

        private static void RunPathTests()
        {
            AssertTrue(SaveStore.HasInvalidColon(@"C:\Games\Save.sav") == false, "HasInvalidColon allows drive path");
            AssertTrue(SaveStore.HasInvalidColon(@"C:\Games\Save.sav:evil") == true, "HasInvalidColon rejects ADS");
            AssertTrue(SaveStore.HasInvalidColon(@"C:Save.sav") == true, "HasInvalidColon rejects drive-relative");
            AssertTrue(SaveStore.HasInvalidColon(":stream") == true, "HasInvalidColon rejects bare stream");

            AssertTrue(SaveStore.IsReservedDeviceName(@"C:\Temp\CON\Save.sav") == true, "IsReservedDeviceName rejects CON dir");
            AssertTrue(SaveStore.IsReservedDeviceName(@"C:\Temp\NUL.sav") == true, "IsReservedDeviceName rejects NUL file");
            AssertTrue(SaveStore.IsReservedDeviceName(@"C:\Temp\COM1.sav") == true, "IsReservedDeviceName rejects COM1");
            AssertTrue(SaveStore.IsReservedDeviceName(@"C:\Temp\LPT9.sav") == true, "IsReservedDeviceName rejects LPT9");
            AssertTrue(SaveStore.IsReservedDeviceName(@"C:\Temp\CONSOLE\Save.sav") == false, "IsReservedDeviceName allows CONSOLE");

            AssertThrows<InvalidDataException>(delegate { SaveStore.EnsureSafePath(@"\\server\share\Save.sav"); }, "EnsureSafePath rejects UNC");
            AssertThrows<InvalidDataException>(delegate { SaveStore.EnsureSafePath("bad\0name.sav"); }, "EnsureSafePath rejects NUL");

            string dir = MakeTempDir();
            try
            {
                string txt = Path.Combine(dir, "notes.txt");
                File.WriteAllText(txt, "x");
                AssertThrows<InvalidDataException>(delegate { SaveStore.ReadSave(txt); }, "ReadSave rejects non-sav");
                AssertThrows<InvalidDataException>(delegate { SaveStore.SaveWithBackup(txt, BuildSyntheticSave(1U, 1U, false), null); }, "SaveWithBackup rejects non-sav");
            }
            finally
            {
                DeleteDirQuiet(dir);
            }

            string hardDir = MakeTempDir();
            try
            {
                string target = Path.Combine(hardDir, "Target.sav");
                string link = Path.Combine(hardDir, "Save.sav");
                File.WriteAllBytes(target, BuildSyntheticSave(1U, 2U, true));
                if (CreateHardLinkW(link, target, IntPtr.Zero))
                {
                    AssertThrows<InvalidDataException>(delegate { SaveStore.NoLinks(link); }, "NoLinks rejects hardlink");
                }
                else
                {
                    AssertTrue(true, "NoLinks hardlink check skipped");
                }
            }
            finally
            {
                DeleteDirQuiet(hardDir);
            }

            string junctionDir = MakeTempDir();
            try
            {
                string real = Path.Combine(junctionDir, "Real");
                string junction = Path.Combine(junctionDir, "Junction");
                Directory.CreateDirectory(real);
                File.WriteAllBytes(Path.Combine(real, "Save.sav"), BuildSyntheticSave(1U, 2U, true));
                ProcessStartInfo psi = new ProcessStartInfo("cmd.exe", "/c mklink /J \"" + junction + "\" \"" + real + "\"");
                psi.UseShellExecute = false;
                psi.CreateNoWindow = true;
                using (Process p = Process.Start(psi))
                {
                    p.WaitForExit();
                }
                string through = Path.Combine(junction, "Save.sav");
                if (Directory.Exists(junction) && File.Exists(through))
                {
                    AssertThrows<InvalidDataException>(delegate { SaveStore.NoLinks(through); }, "NoLinks rejects junction");
                }
                else
                {
                    AssertTrue(true, "NoLinks junction check skipped");
                }
            }
            finally
            {
                DeleteDirQuiet(junctionDir);
            }
        }

        private static void RunBinaryTests()
        {
            byte[] title = BuildSyntheticSave(0U, 88888U, false);
            byte[] story = BuildSyntheticSave(777777U, 88888U, true);
            SaveStore.ValidateSaveBytes(title);
            SaveStore.ValidateSaveBytes(story);
            AssertTrue(true, "ValidateSaveBytes accepts title save");
            AssertTrue(true, "ValidateSaveBytes accepts story save");
            AssertTrue(SaveStore.ReadCoinOrZero(title) == 0U, "ReadCoinOrZero returns 0 on title save");
            AssertTrue(SaveStore.ReadCoinOrZero(story) == 777777U, "ReadCoinOrZero reads story coin");
            AssertTrue(SaveStore.ReadSilverOrZero(story) == 88888U, "ReadSilverOrZero reads silver");

            AssertThrows<InvalidDataException>(delegate { SaveStore.ValidateSaveBytes(null); }, "ValidateSaveBytes rejects null");
            AssertThrows<InvalidDataException>(delegate { SaveStore.ValidateSaveBytes(new byte[0]); }, "ValidateSaveBytes rejects empty");

            byte[] truncated = new byte[title.Length - 1];
            Array.Copy(title, truncated, truncated.Length);
            AssertThrows<InvalidDataException>(delegate { SaveStore.ValidateSaveBytes(truncated); }, "ValidateSaveBytes rejects truncated");

            byte[] trailing = new byte[title.Length + 1];
            Array.Copy(title, trailing, title.Length);
            AssertThrows<InvalidDataException>(delegate { SaveStore.ValidateSaveBytes(trailing); }, "ValidateSaveBytes rejects trailing");

            byte[] tooMany = (byte[])title.Clone();
            WriteUInt32LE(tooMany, SaveStore.HeaderSize, (uint)(SaveStore.MaxRecords + 1));
            AssertThrows<InvalidDataException>(delegate { SaveStore.ValidateSaveBytes(tooMany); }, "ValidateSaveBytes rejects count > MaxRecords");
        }

        private static void RunDiscoveryAndSaveTests()
        {
            string root = MakeTempDir();
            string slotDir = Path.Combine(root, "SaveFile", "1");
            Directory.CreateDirectory(slotDir);

            byte[] autoBytes = BuildSyntheticSave(111111U, 22222U, true);
            byte[] manualBytes = BuildSyntheticSave(333333U, 44444U, true);
            string autoPath = Path.Combine(root, "Save.sav");
            string manualPath = Path.Combine(slotDir, "Save.sav");
            File.WriteAllBytes(autoPath, autoBytes);
            File.WriteAllBytes(manualPath, manualBytes);

            try
            {
                List<SaveSlotInfo> found = SaveStore.DiscoverSaves(root);
                bool hasAuto = false;
                bool hasManual = false;
                for (int i = 0; i < found.Count; i++)
                {
                    if (string.Equals(found[i].Path, autoPath, StringComparison.OrdinalIgnoreCase) && found[i].IsAuto) hasAuto = true;
                    if (string.Equals(found[i].Path, manualPath, StringComparison.OrdinalIgnoreCase) && !found[i].IsAuto) hasManual = true;
                }
                AssertTrue(hasAuto, "DiscoverSaves finds root auto Save.sav");
                AssertTrue(hasManual, "DiscoverSaves finds SaveFile\\1\\Save.sav");

                SaveReadResult read = SaveStore.ReadSave(autoPath);
                AssertBytesEqual(autoBytes, read.DataBytes, "ReadSave returns exact bytes");
                AssertTrue(read.Sha256 == SaveStore.ComputeSha256(autoBytes), "ReadSave sha256 matches");

                byte[] updated = BuildSyntheticSave(999999U, 55555U, true);
                SaveResult saved = SaveStore.SaveWithBackup(autoPath, updated, read.Sha256);
                AssertTrue(saved.Success, "SaveWithBackup succeeds");
                AssertBytesEqual(updated, File.ReadAllBytes(autoPath), "SaveWithBackup updates disk bytes");
                AssertTrue(!string.IsNullOrEmpty(saved.BackupPath) && File.Exists(saved.BackupPath), "SaveWithBackup creates backup file");
                AssertTrue(SaveStore.ComputeSha256(File.ReadAllBytes(saved.BackupPath)) == read.Sha256, "Backup sha256 matches original");

                AssertThrows<InvalidDataException>(delegate { SaveStore.SaveWithBackup(autoPath, updated, "0000000000000000000000000000000000000000000000000000000000000000"); }, "SaveWithBackup rejects wrong expectedSha256");

                string oldEnv = Environment.GetEnvironmentVariable(SaveStore.SimulateRunningVar);
                try
                {
                    Environment.SetEnvironmentVariable(SaveStore.SimulateRunningVar, "1");
                    AssertTrue(SaveStore.IsGameRunning() == true, "IsGameRunning detects MYJH_SIMULATE_GAME_RUNNING");
                    AssertThrows<IOException>(delegate { SaveStore.SaveWithBackup(autoPath, updated, saved.NewSha256); }, "SaveWithBackup blocks while game running");
                }
                finally
                {
                    Environment.SetEnvironmentVariable(SaveStore.SimulateRunningVar, oldEnv);
                }
            }
            finally
            {
                DeleteDirQuiet(root);
            }
        }
    }
}
