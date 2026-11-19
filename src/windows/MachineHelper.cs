using System;
using System.ComponentModel;
using System.Diagnostics;
using System.Globalization;
using System.IO;
using System.Security.Cryptography;
using System.Security.AccessControl;
using System.Security.Principal;
using System.Text.RegularExpressions;

internal static class MachineHelper
{
    private static int Main(string[] args)
    {
        if (args.Length == 1 && args[0] == "program-data")
        {
            Console.OutputEncoding = new System.Text.UTF8Encoding(false);
            Console.WriteLine(Environment.GetFolderPath(Environment.SpecialFolder.CommonApplicationData));
            return 0;
        }
        if (args.Length == 1 && args[0] == "ota-cache") return OtaCache();
        if (args.Length == 3 && args[0] == "ota-install") return OtaInstall(args[1], args[2]);
        if (args.Length == 1 && (args[0] == "protect" || args[0] == "unprotect"))
        {
            return Crypt(args[0] == "protect", "gen-NetTools/model-access/v1");
        }
        if (args.Length == 1 && (args[0] == "ota-protect" || args[0] == "ota-unprotect"))
            return Crypt(args[0] == "ota-protect", "gen-NetTools/ota-access/v1");
        if (args.Length == 1 && args[0] == "purge-data") return PurgeData();
        if (args.Length == 1 && args[0] == "prepare-data") return PrepareData();
        if (args.Length == 2 && args[0] == "purge-app") return PurgeApp(args[1]);
        if (args.Length != 2 || args[0] != "lock") return 64;
        try
        {
            using (var handle = new FileStream(args[1], FileMode.OpenOrCreate, FileAccess.ReadWrite, FileShare.None))
            {
                Console.WriteLine("ready");
                // Parent closure or termination closes stdin and releases the machine-wide file handle.
                Console.In.ReadToEnd();
            }
            return 0;
        }
        catch (IOException)
        {
            Console.WriteLine("busy");
            return 1;
        }
        catch (UnauthorizedAccessException)
        {
            Console.WriteLine("denied");
            return 2;
        }
    }

    private static int PrepareData()
    {
        try
        {
            string baseDir = Environment.GetFolderPath(Environment.SpecialFolder.CommonApplicationData);
            if (String.IsNullOrEmpty(baseDir)) return 68;
            string path = Path.Combine(baseDir, "gen-NetTools");
            if (HasLink(path)) return 68;
            if (!Directory.Exists(path))
            {
                var security = new DirectorySecurity();
                var users = new SecurityIdentifier(WellKnownSidType.BuiltinUsersSid, null);
                security.AddAccessRule(new FileSystemAccessRule(users, FileSystemRights.Modify,
                    InheritanceFlags.ContainerInherit | InheritanceFlags.ObjectInherit, PropagationFlags.None, AccessControlType.Allow));
                Directory.CreateDirectory(path, security);
            }
            return 0;
        }
        catch (IOException) { return 67; }
        catch (UnauthorizedAccessException) { return 68; }
    }

    private static string OtaCachePath()
    {
        string local = Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);
        if (String.IsNullOrEmpty(local)) return null;
        return Path.GetFullPath(Path.Combine(local, "gen-NetTools", "ota-cache"));
    }

    private static int OtaCache()
    {
        try
        {
            string path = OtaCachePath();
            if (String.IsNullOrEmpty(path) || HasLink(path)) return 68;
            Directory.CreateDirectory(path);
            if (HasLink(path)) return 68;
            Console.OutputEncoding = new System.Text.UTF8Encoding(false);
            Console.WriteLine(path);
            return 0;
        }
        catch (IOException) { return 67; }
        catch (UnauthorizedAccessException) { return 68; }
        catch (ArgumentException) { return 68; }
    }

    private static int OtaInstall(string requestedPath, string expectedHash)
    {
        try
        {
            if (String.IsNullOrEmpty(requestedPath) || !Path.IsPathRooted(requestedPath) ||
                String.IsNullOrEmpty(expectedHash) || expectedHash.Length != 64) return 68;

            byte[] expected = new byte[32];
            for (int i = 0; i < expected.Length; i++)
            {
                if (!Uri.IsHexDigit(expectedHash[i * 2]) || !Uri.IsHexDigit(expectedHash[i * 2 + 1])) return 68;
                expected[i] = Byte.Parse(expectedHash.Substring(i * 2, 2), NumberStyles.AllowHexSpecifier, CultureInfo.InvariantCulture);
            }

            string cache = OtaCachePath();
            if (String.IsNullOrEmpty(cache)) return 68;
            cache = cache.TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar);
            string file = Path.GetFullPath(requestedPath);
            string manifestDirectory = Path.GetDirectoryName(file);
            string manifestName = Path.GetFileName(manifestDirectory);
            string parent = Path.GetDirectoryName(manifestDirectory);
            if (!String.Equals(parent, cache, StringComparison.OrdinalIgnoreCase) ||
                !Regex.IsMatch(manifestName ?? "", "^[0-9a-f]{64}$", RegexOptions.CultureInvariant) ||
                !Regex.IsMatch(Path.GetFileName(file), "^gen-NetTools-[0-9][A-Za-z0-9.+-]*-win-x64-setup\\.exe$", RegexOptions.CultureInvariant) ||
                HasLink(cache) || HasLink(manifestDirectory) || HasLink(file) || !File.Exists(file) || Directory.Exists(file)) return 68;

            using (var stream = new FileStream(file, FileMode.Open, FileAccess.Read, FileShare.Read))
            using (var sha = SHA256.Create())
            {
                if ((File.GetAttributes(file) & FileAttributes.ReparsePoint) != 0) return 68;
                byte[] actual = sha.ComputeHash(stream);
                int difference = 0;
                for (int i = 0; i < actual.Length; i++) difference |= actual[i] ^ expected[i];
                Array.Clear(actual, 0, actual.Length);
                Array.Clear(expected, 0, expected.Length);
                if (difference != 0) return 68;

                string systemDirectory = Environment.GetFolderPath(Environment.SpecialFolder.System);
                if (String.IsNullOrEmpty(systemDirectory) || HasLink(systemDirectory)) return 69;
                var start = new ProcessStartInfo(file)
                {
                    UseShellExecute = true,
                    Verb = "runas",
                    WorkingDirectory = systemDirectory
                };
                Process launched = Process.Start(start);
                if (launched == null) return 69;
                launched.Dispose();
                return 0;
            }
        }
        catch (Win32Exception error)
        {
            return error.NativeErrorCode == 1223 ? 1223 : 69;
        }
        catch (IOException) { return 67; }
        catch (UnauthorizedAccessException) { return 68; }
        catch (ArgumentException) { return 68; }
        catch (CryptographicException) { return 68; }
        catch (InvalidOperationException) { return 69; }
    }

    private static bool Exists(string path)
    {
        try { File.GetAttributes(path); return true; }
        catch (FileNotFoundException) { return false; }
        catch (DirectoryNotFoundException) { return false; }
    }

    private static bool HasLink(string path)
    {
        for (string current = path; !String.IsNullOrEmpty(current); current = Path.GetDirectoryName(current))
        {
            if (Exists(current) && (File.GetAttributes(current) & FileAttributes.ReparsePoint) != 0) return true;
        }
        return false;
    }

    private static bool DeleteTree(string path)
    {
        if (!Exists(path)) return true;
        if ((File.GetAttributes(path) & FileAttributes.ReparsePoint) != 0) return false;
        if (Directory.Exists(path))
        {
            bool clean = true;
            foreach (string entry in Directory.GetFileSystemEntries(path)) clean &= DeleteTree(entry);
            if (clean) Directory.Delete(path, false);
            return clean;
        }
        File.Delete(path);
        return true;
    }

    private static int PurgeData()
    {
        try
        {
            string baseDir = Environment.GetFolderPath(Environment.SpecialFolder.CommonApplicationData);
            if (String.IsNullOrEmpty(baseDir)) return 68;
            string path = Path.Combine(baseDir, "gen-NetTools");
            if (HasLink(path)) return 68;
            bool clean = true;
            foreach (string name in new[] { "workspace.sqlite3", "workspace.sqlite3-wal", "workspace.sqlite3-shm", "electron", "session", "crash", "logs" })
            {
                clean &= DeleteTree(Path.Combine(path, name));
            }
            return clean ? 0 : 68;
        }
        catch (IOException) { return 67; }
        catch (UnauthorizedAccessException) { return 68; }
    }

    private static int PurgeApp(string requested)
    {
        try
        {
            string path = Path.GetFullPath(requested);
            string name = Path.GetFileName(path);
            if (name != "app" && name != "app.pending" && name != "app.previous") return 68;
            string marker = Path.Combine(Path.GetDirectoryName(path), "gen-NetTools.install");
            if (HasLink(path) || HasLink(marker) || !File.Exists(marker) || File.ReadAllText(marker) != "gen-NetTools") return 68;
            return DeleteTree(path) ? 0 : 68;
        }
        catch (IOException) { return 67; }
        catch (UnauthorizedAccessException) { return 68; }
        catch (ArgumentException) { return 68; }
    }

    private static int Crypt(bool protect, string entropyText)
    {
        byte[] input = new byte[16384];
        byte[] exactInput = null;
        byte[] output = null;
        byte[] context = null;
        try
        {
            Stream source = Console.OpenStandardInput();
            int length = 0;
            while (length < input.Length)
            {
                int read = source.Read(input, length, input.Length - length);
                if (read == 0) break;
                length += read;
            }
            if (length == 0 || length == input.Length) return 65;
            exactInput = new byte[length];
            Buffer.BlockCopy(input, 0, exactInput, 0, length);
            context = System.Text.Encoding.UTF8.GetBytes(entropyText);
            output = protect
                ? ProtectedData.Protect(exactInput, context, DataProtectionScope.LocalMachine)
                : ProtectedData.Unprotect(exactInput, context, DataProtectionScope.LocalMachine);
            using (Stream target = Console.OpenStandardOutput()) target.Write(output, 0, output.Length);
            return 0;
        }
        catch (CryptographicException) { return 66; }
        catch (IOException) { return 67; }
        finally
        {
            Array.Clear(input, 0, input.Length);
            if (exactInput != null) Array.Clear(exactInput, 0, exactInput.Length);
            if (output != null) Array.Clear(output, 0, output.Length);
            if (context != null) Array.Clear(context, 0, context.Length);
        }
    }
}
