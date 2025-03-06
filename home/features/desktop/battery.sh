#!/bin/bash

get_battery() {
    cat /sys/class/power_supply/BAT0/capacity
}

while true; do
    battery=$(get_battery)
    
    # Send a desktop notification with the battery percentage.
    notify-send "Battery Status" "Charge: ${battery}%"
    
    # Adjust the sleep interval based on the current battery percentage.
    if [ "$battery" -gt 50 ]; then
        # sleep 600   # 10 minutes when battery > 50%
        sleep 5
    elif [ "$battery" -gt 20 ]; then
        sleep 300   # 5 minutes when battery is between 21% and 50%
    elif [ "$battery" -gt 10 ]; then
        sleep 120   # 2 minutes when battery is between 11% and 20%
    else
        sleep 60    # 1 minute when battery is 10% or lower
    fi
done
