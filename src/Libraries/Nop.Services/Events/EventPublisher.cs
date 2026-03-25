using System.Diagnostics;
using Nop.Core.Events;
using Nop.Core.Infrastructure;
using Nop.Core.Observability;
using Nop.Services.Logging;

namespace Nop.Services.Events;

/// <summary>
/// Represents the event publisher implementation
/// </summary>
public partial class EventPublisher : IEventPublisher
{
    #region Methods

    /// <summary>
    /// Publish event to consumers
    /// </summary>
    /// <typeparam name="TEvent">Type of event</typeparam>
    /// <param name="event">Event object</param>
    /// <returns>A task that represents the asynchronous operation</returns>
    public virtual async Task PublishAsync<TEvent>(TEvent @event)
    {
        var eventName = typeof(TEvent).FullName ?? typeof(TEvent).Name;

        //get all event consumers
        var consumers = EngineContext.Current.ResolveAll<IConsumer<TEvent>>().ToList();
        var hasFailures = false;

        using var publishActivity = NopTelemetry.ActivitySource.StartActivity("event.publish", ActivityKind.Internal);
        publishActivity?.SetTag("event.name", eventName);
        publishActivity?.SetTag("event.consumer_count", consumers.Count);

        foreach (var consumer in consumers)
        {
            var consumerName = consumer.GetType().FullName ?? consumer.GetType().Name;

            using var consumerActivity = NopTelemetry.ActivitySource.StartActivity("event.consume", ActivityKind.Internal);
            consumerActivity?.SetTag("event.name", eventName);
            consumerActivity?.SetTag("event.consumer", consumerName);

            try
            {
                //try to handle published event
                await consumer.HandleEventAsync(@event);
                consumerActivity?.SetStatus(ActivityStatusCode.Ok);

                if (@event is IStopProcessingEvent { StopProcessing: true })
                {
                    publishActivity?.SetTag("event.stop_processing", true);
                    break;
                }
            }
            catch (Exception exception)
            {
                hasFailures = true;
                consumerActivity?.SetTag("event.result", "failed");
                consumerActivity?.SetTag("exception.type", NopTelemetry.GetExceptionType(exception));
                consumerActivity?.AddEvent(new ActivityEvent("exception"));
                consumerActivity?.SetStatus(ActivityStatusCode.Error, exception.GetType().Name);

                //log error, we put in to nested try-catch to prevent possible cyclic (if some error occurs)
                try
                {
                    var logger = EngineContext.Current.Resolve<ILogger>();
                    if (logger == null)
                        return;

                    await logger.ErrorAsync(exception.Message, exception);
                }
                catch
                {
                    // ignored
                }
            }
        }

        publishActivity?.SetTag("event.result", hasFailures ? "partial_failure" : "success");
        publishActivity?.SetStatus(hasFailures ? ActivityStatusCode.Error : ActivityStatusCode.Ok);
    }

    #endregion
}
