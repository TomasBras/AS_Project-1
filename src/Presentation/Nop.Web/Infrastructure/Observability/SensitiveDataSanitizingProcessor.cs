using System.Diagnostics;
using OpenTelemetry;

namespace Nop.Web.Infrastructure.Observability;

/// <summary>
/// Removes span attributes that could leak customer or payment data before export.
/// </summary>
public sealed class SensitiveDataSanitizingProcessor : BaseProcessor<Activity>
{
    private static readonly string[] _sensitiveFragments =
    [
        "address",
        "card",
        "cvv",
        "email",
        "exception.message",
        "password",
        "phone",
        "query",
        "token"
    ];

    public override void OnEnd(Activity data)
    {
        foreach (var tag in data.TagObjects.ToList())
        {
            if (string.IsNullOrWhiteSpace(tag.Key))
                continue;

            if (_sensitiveFragments.Any(fragment => tag.Key.Contains(fragment, StringComparison.OrdinalIgnoreCase)))
                data.SetTag(tag.Key, null);
        }
    }
}
