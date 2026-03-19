using Autofac.Extensions.DependencyInjection;
using Nop.Core.Configuration;
using Nop.Core.Infrastructure;
using Nop.Web.Infrastructure.Observability;
using Nop.Web.Framework.Infrastructure.Extensions;
using OpenTelemetry.Metrics;
using OpenTelemetry.Resources;
using OpenTelemetry.Trace;

namespace Nop.Web;

public partial class Program
{
    public static async Task Main(string[] args)
    {
        var builder = WebApplication.CreateBuilder(args);

        builder.Configuration.AddJsonFile(NopConfigurationDefaults.AppSettingsFilePath, true, true);
        if (!string.IsNullOrEmpty(builder.Environment?.EnvironmentName))
        {
            var path = string.Format(NopConfigurationDefaults.AppSettingsEnvironmentFilePath, builder.Environment.EnvironmentName);
            builder.Configuration.AddJsonFile(path, true, true);
        }
        builder.Configuration.AddEnvironmentVariables();

        var serviceName = "nop.web";
        var serviceVersion = typeof(Program).Assembly.GetName().Version?.ToString() ?? "unknown";
        var otlpEndpoint = builder.Configuration["OTEL_EXPORTER_OTLP_ENDPOINT"] ?? "http://localhost:4317";
        var resourceBuilder = ResourceBuilder.CreateDefault()
            .AddService(serviceName: serviceName, serviceVersion: serviceVersion);

        builder.Services.AddOpenTelemetry()
            .ConfigureResource(resource => resource.AddService(serviceName: serviceName, serviceVersion: serviceVersion))
            .WithTracing(tracing => tracing
                .SetResourceBuilder(resourceBuilder)
                .AddAspNetCoreInstrumentation(options =>
                {
                    options.RecordException = true;
                    options.Filter = context =>
                        !context.Request.Path.StartsWithSegments("/health", StringComparison.OrdinalIgnoreCase);
                })
                .AddHttpClientInstrumentation()
                .AddOtlpExporter(options => options.Endpoint = new Uri(otlpEndpoint)))
            .WithMetrics(metrics => metrics
                .SetResourceBuilder(resourceBuilder)
                .AddAspNetCoreInstrumentation()
                .AddHttpClientInstrumentation()
                .AddRuntimeInstrumentation()
                .AddMeter(CheckoutTelemetry.MeterName)
                .AddOtlpExporter(options => options.Endpoint = new Uri(otlpEndpoint)));

        //load application settings
        builder.Services.ConfigureApplicationSettings(builder);

        var appSettings = Singleton<AppSettings>.Instance;
        var useAutofac = appSettings.Get<CommonConfig>().UseAutofac;

        if (useAutofac)
            builder.Host.UseServiceProviderFactory(new AutofacServiceProviderFactory());
        else
        {
            builder.Host.UseDefaultServiceProvider(options =>
            {
                //we don't validate the scopes, since at the app start and the initial configuration we need 
                //to resolve some services (registered as "scoped") through the root container
                options.ValidateScopes = false;
                options.ValidateOnBuild = true;
            });
        }

        //add services to the application and configure service provider
        builder.Services.ConfigureApplicationServices(builder);

        var app = builder.Build();

        //configure the application HTTP request pipeline
        app.ConfigureRequestPipeline();
        await app.PublishAppStartedEventAsync();

        await app.RunAsync();
    }
}
