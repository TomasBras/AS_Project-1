using System.Diagnostics;

namespace Nop.Core.Observability;

/// <summary>
/// Shared tracing primitives used across web and service boundaries.
/// </summary>
public static class NopTelemetry
{
    public const string ActivitySourceName = "NopCommerce.Observability";

    public static readonly ActivitySource ActivitySource = new(ActivitySourceName);

    public static string GetExceptionType(Exception exception) =>
        exception.GetType().FullName ?? exception.GetType().Name;
}
