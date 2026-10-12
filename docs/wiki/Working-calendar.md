中文：[工作日历](工作日历.md)

## Working days you define

The working calendar supports holidays, chosen weekends, make-up workdays, country presets and calendar-file import/export. Review the relevant year and edit dates to reflect your own organization.

Each reminder has its own working-day policy. The default is off: adding holidays to a calendar does not automatically alter every reminder. Enable the policy on the tasks that should follow it and inspect their next execution or impact preview.

## Time zones and time windows

Scheduling uses the device's time context. A contact's delivery window can use a different time zone and working hours. Review that window when sending across regions; the same clock time does not mean the same instant everywhere.

Quiet hours, the working calendar and the recipient's delivery window can move a scheduled send. Check the resulting time rather than only the recurrence expression.

## Chinese statutory data

China's holidays include make-up workdays on some weekends. They cannot be replaced by a blanket weekend rule. The bundled table records the years it covers; fetching a new year is a manual action with a displayed source. Do not reuse an old year's dates when the new year's data is unavailable.

## Calendar files and subscriptions

Calendar exports can describe a recurrence rule or computed send times; computed lists have a limited horizon. The optional local calendar subscription serves holidays and make-up days, not reminders or their recipients. Its address is loopback-only and cannot act as a public cloud-calendar feed.

Details are in the [calendar feature reference](https://github.com/Aevorine/Aevistle/blob/main/docs/FEATURES.md#the-calendar).
