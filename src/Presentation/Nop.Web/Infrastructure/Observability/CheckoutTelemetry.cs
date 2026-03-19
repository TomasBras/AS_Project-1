using System.Diagnostics;
using System.Diagnostics.Metrics;

namespace Nop.Web.Infrastructure.Observability;

/// <summary>
/// Checkout-specific custom metrics.
/// </summary>
public static class CheckoutTelemetry
{
    public const string MeterName = "Nop.Web.Checkout";

    private static readonly Meter _meter = new(MeterName, "1.0.0");

    private static readonly Counter<long> _checkoutAttempts = _meter.CreateCounter<long>(
        name: "checkout_attempts_total",
        unit: "{attempt}",
        description: "Total number of checkout placement attempts.");

    private static readonly Histogram<double> _checkoutDuration = _meter.CreateHistogram<double>(
        name: "checkout_duration_seconds",
        unit: "s",
        description: "Checkout placement duration in seconds.");

    private static readonly Counter<long> _paymentAttempts = _meter.CreateCounter<long>(
        name: "payment_attempts_total",
        unit: "{attempt}",
        description: "Total number of payment attempts by provider and method.");

    private static readonly Histogram<double> _paymentLatency = _meter.CreateHistogram<double>(
        name: "payment_latency_seconds",
        unit: "s",
        description: "Payment processing latency in seconds by provider.");

    private static readonly Counter<long> _paymentFailures = _meter.CreateCounter<long>(
        name: "payment_failures_total",
        unit: "{failure}",
        description: "Total number of payment failures by provider and reason code.");

    private static readonly Counter<long> _checkoutStepDropoff = _meter.CreateCounter<long>(
        name: "checkout_step_dropoff_total",
        unit: "{dropoff}",
        description: "Total number of checkout drop-offs by step and reason.");

    public static void RecordAttempt(string flow, string result, string paymentMethod = null, string errorType = null)
    {
        var tags = new TagList
        {
            { "flow", flow },
            { "result", result }
        };

        if (!string.IsNullOrWhiteSpace(paymentMethod))
            tags.Add("payment_method", paymentMethod);

        if (!string.IsNullOrWhiteSpace(errorType))
            tags.Add("error_type", errorType);

        _checkoutAttempts.Add(1, tags);
    }

    public static void RecordDuration(double seconds, string flow, string result, string paymentMethod = null)
    {
        var tags = new TagList
        {
            { "flow", flow },
            { "result", result }
        };

        if (!string.IsNullOrWhiteSpace(paymentMethod))
            tags.Add("payment_method", paymentMethod);

        _checkoutDuration.Record(seconds, tags);
    }

    public static void RecordPaymentAttempt(string provider, string method, string result)
    {
        var tags = new TagList
        {
            { "provider", provider ?? "unknown" },
            { "method", method ?? "unknown" },
            { "result", result ?? "unknown" }
        };

        _paymentAttempts.Add(1, tags);
    }

    public static void RecordPaymentLatency(double seconds, string provider, string method, string result)
    {
        var tags = new TagList
        {
            { "provider", provider ?? "unknown" },
            { "method", method ?? "unknown" },
            { "result", result ?? "unknown" }
        };

        _paymentLatency.Record(seconds, tags);
    }

    public static void RecordPaymentFailure(string provider, string method, string reasonCode)
    {
        var tags = new TagList
        {
            { "provider", provider ?? "unknown" },
            { "method", method ?? "unknown" },
            { "reason_code", reasonCode ?? "unknown" }
        };

        _paymentFailures.Add(1, tags);
    }

    public static void RecordStepDropoff(string step, string reasonCode)
    {
        var tags = new TagList
        {
            { "step", step ?? "unknown" },
            { "reason_code", reasonCode ?? "unknown" }
        };

        _checkoutStepDropoff.Add(1, tags);
    }
}
