using System.Reflection;
using System.Text.Json;
using SharpCompress.Common.Rar.Headers;
using SharpCompress.IO;
using SharpCompress.Readers;

static object? GetReflectionProperty(object instance, string name)
{
    return instance.GetType().GetProperty(name, BindingFlags.Instance | BindingFlags.Public | BindingFlags.NonPublic)?.GetValue(instance);
}

static object? GetReflectionField(object instance, string name)
{
    return instance.GetType().GetField(name, BindingFlags.Instance | BindingFlags.Public | BindingFlags.NonPublic)?.GetValue(instance);
}

static byte GetByte(object header, string name)
{
    return Convert.ToByte(GetReflectionProperty(header, name));
}

static long GetLong(object header, string name)
{
    return Convert.ToInt64(GetReflectionProperty(header, name));
}

static string GetString(object header, string name)
{
    return Convert.ToString(GetReflectionProperty(header, name)) ?? "";
}

static bool GetBool(object header, string name)
{
    return Convert.ToBoolean(GetReflectionProperty(header, name));
}

static int? GetVolumeNumber(IRarHeader header)
{
    var value = header.HeaderType == HeaderType.Archive
        ? GetReflectionProperty(header, "VolumeNumber")
        : GetReflectionProperty(header, "VolumeNumber");
    return value == null ? null : Convert.ToInt32(value);
}

var file = args.Length > 0 ? args[0] : null;
var password = args.Length > 1 ? args[1] : null;
if (string.IsNullOrWhiteSpace(file) || !File.Exists(file))
{
    Console.Error.WriteLine("usage: Drakkar.ArchiveProbe <rar-header-file> [password]");
    return 2;
}

var headers = new List<object>();
try
{
    await using var stream = File.OpenRead(file);
    var readerOptions = new ReaderOptions { Password = password };
    var headerFactory = new RarHeaderFactory(StreamingMode.Seekable, readerOptions);

    foreach (var header in headerFactory.ReadHeaders(stream))
    {
        if (header.HeaderType is HeaderType.Archive or HeaderType.EndArchive)
        {
            headers.Add(new
            {
                kind = header.HeaderType.ToString(),
                volumeNumber = GetVolumeNumber(header),
                isFirstVolume = GetBool(header, "IsFirstVolume")
            });
            continue;
        }

        if (header.HeaderType == HeaderType.Service)
        {
            var filename = GetString(header, "FileName");
            if (filename == "CMT")
            {
                var compressedSize = GetLong(header, "CompressedSize");
                if (compressedSize > 0) stream.Seek(compressedSize, SeekOrigin.Current);
            }
            continue;
        }

        if (header.HeaderType != HeaderType.File || GetBool(header, "IsDirectory") || GetString(header, "FileName") == "QO")
        {
            continue;
        }

        var rar5CryptoInfo = GetReflectionProperty(header, "Rar5CryptoInfo");
        headers.Add(new
        {
            kind = "File",
            name = GetString(header, "FileName"),
            dataStart = GetLong(header, "DataStartPosition"),
            packedSize = GetLong(header, "AdditionalDataSize"),
            compressedSize = GetLong(header, "CompressedSize"),
            unpackedSize = GetLong(header, "UncompressedSize"),
            compressionMethod = GetByte(header, "CompressionMethod"),
            isEncrypted = GetBool(header, "IsEncrypted"),
            isSolid = GetBool(header, "IsSolid"),
            hasRar5Crypto = rar5CryptoInfo != null,
            hasRar3Salt = GetReflectionProperty(header, "R4Salt") != null,
            rar5Lg2Count = rar5CryptoInfo == null ? null : GetReflectionField(rar5CryptoInfo, "LG2Count")
        });
    }
}
catch (EndOfStreamException)
{
    // Header slice can end after useful headers. Return what was found.
}
catch (InvalidDataException)
{
    // Header slice can end after useful headers. Return what was found.
}

Console.WriteLine(JsonSerializer.Serialize(new { headers }));
return 0;
