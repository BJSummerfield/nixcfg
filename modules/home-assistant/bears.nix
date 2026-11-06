let
  delay = "input_number.bears_tv_delay";
  mark = "input_number.bears_score_mark";
  eventId = "input_text.bears_event";
  notify = notification_id: title: message: {
    action = "persistent_notification.create";
    data = {
      inherit notification_id title message;
    };
  };
  calibrated = notify "bears_calibration";
  setDelay = {
    action = "input_number.set_value";
    target.entity_id = delay;
    data.value = "{{ [[raw, state_attr('${delay}', 'min') | float(0)] | max, state_attr('${delay}', 'max') | float(120)] | min }}";
  };
  gameModeOn = {
    condition = "state";
    entity_id = "input_boolean.bears_game_mode";
    state = "on";
  };
  celebrate = {
    action = "script.turn_on";
    target.entity_id = "script.bears_celebration";
  };
  lightOn = alias: entity_id: data: {
    inherit alias data;
    action = "light.turn_on";
    target = {
      inherit entity_id;
    };
  };
in
{
  sensor = [
    {
      platform = "teamtracker";
      league_id = "NFL";
      team_id = "CHI";
      name = "bears";
    }
  ];

  input_boolean.bears_game_mode = {
    name = "Bears game mode";
    icon = "mdi:football";
  };

  input_number.bears_tv_delay = {
    name = "Bears TV delay";
    icon = "mdi:timer-sand";
    min = 0;
    max = 120;
    step = 1;
    unit_of_measurement = "s";
    mode = "slider";
  };

  input_number.bears_score_mark = {
    name = "Bears score mark";
    icon = "mdi:scoreboard-outline";
    min = 0;
    max = 999;
    step = 1;
    mode = "box";
  };

  input_text.bears_tv_clock = {
    name = "Bears TV clock";
    icon = "mdi:clock-digital";
    max = 5;
    pattern = "[0-9]{1,2}:[0-5][0-9]";
  };

  input_text.bears_event = {
    name = "Bears game event";
    icon = "mdi:identifier";
  };

  input_datetime.bears_last_score = {
    name = "Bears last score";
    has_date = true;
    has_time = true;
  };

  script = {
    bears_celebration = {
      alias = "Bears celebration";
      icon = "mdi:football";
      mode = "queued";
      max = 10;
      variables = {
        lamps_a = [ "light.living_room_hue_color_lamp_1" ];
        lamps_b = [ "light.living_room_hue_color_lamp_2" ];
        sinks = [
          "light.kitchen_kitchen_sink1"
          "light.kitchen_kitchen_sink2"
          "light.kitchen_kitchen_sink3"
        ];
        orange = "[200, 56, 3]";
        blue = "[0, 70, 255]";
        beats = 9;
      };
      sequence = [
        {
          variables = {
            lamps = "{{ lamps_a + lamps_b }}";
            sparklers = "{{ expand(lamps_a + lamps_b) | selectattr('attributes.effect_list', 'defined') | selectattr('attributes.effect_list', 'contains', 'sparkle') | map(attribute='entity_id') | list }}";
          };
        }
        {
          alias = "Remember how the lights are now";
          action = "scene.create";
          data = {
            scene_id = "bears_celebration_before";
            snapshot_entities = "{{ lamps + sinks }}";
          };
        }
        (lightOn "Kitchen to warm amber, low" "{{ sinks }}" {
          color_temp_kelvin = 2000;
          brightness_pct = 20;
          transition = 1;
        })
        {
          alias = "Lamps trade orange and blue while the kitchen waves";
          repeat = {
            count = "{{ beats }}";
            sequence = [
              (lightOn "First lamps" "{{ lamps_a }}" {
                rgb_color = "{{ orange if repeat.index is odd else blue }}";
                brightness_pct = 100;
                transition = 0.4;
              })
              (lightOn "Second lamps, opposite colour" "{{ lamps_b }}" {
                rgb_color = "{{ blue if repeat.index is odd else orange }}";
                brightness_pct = 100;
                transition = 0.4;
              })
              (lightOn "Previous sink falls back" "{{ sinks[(repeat.index - 2) % (sinks | count)] }}" {
                brightness_pct = 20;
                transition = 0.8;
              })
              (lightOn "Next sink swells" "{{ sinks[(repeat.index - 1) % (sinks | count)] }}" {
                brightness_pct = 100;
                transition = 0.8;
              })
              { delay.seconds = 1; }
            ];
          };
        }
        (lightOn "Finale, lamps orange" "{{ lamps }}" {
          rgb_color = "{{ orange }}";
          brightness_pct = 100;
          transition = 0.5;
        })
        (lightOn "Finale, kitchen full amber" "{{ sinks }}" {
          brightness_pct = 100;
          transition = 0.5;
        })
        { delay.seconds = 1; }
        {
          alias = "Orange sparkle";
          "if" = "{{ sparklers | count > 0 }}";
          "then" = [
            (lightOn "Sparkle on" "{{ sparklers }}" { effect = "sparkle"; })
            { delay.seconds = 3; }
            (lightOn "Sparkle off" "{{ sparklers }}" { effect = "off"; })
            { delay.seconds = 1; }
          ];
        }
        {
          alias = "Put every light back";
          action = "scene.turn_on";
          target.entity_id = "scene.bears_celebration_before";
          data.transition = 1;
        }
        {
          alias = "Let the lights settle before a queued celebration";
          delay.seconds = 2;
        }
      ];
    };

    bears_test_celebration = {
      alias = "Bears test celebration";
      icon = "mdi:football";
      sequence = [ celebrate ];
    };

    bears_calibrate_from_clock = {
      alias = "Bears calibrate delay from TV clock";
      icon = "mdi:timer-sync-outline";
      sequence = [
        {
          variables = {
            tv = "{{ states('input_text.bears_tv_clock') | trim }}";
            feed = "{{ state_attr('sensor.bears', 'clock') or \"\" }}";
            fetched = "{{ as_timestamp(state_attr('sensor.bears', 'last_update'), none) }}";
          };
        }
        {
          "if" =
            "{{ is_state('sensor.bears', 'IN') and tv is match('[0-9]{1,2}:[0-5][0-9]$') and feed is match('[0-9]{1,2}:[0-9]{2} ') and fetched is not none }}";
          "then" = [
            {
              variables = {
                tv_s = "{% set c = tv.split(':') %}{{ (c[0] | int) * 60 + (c[1] | int) }}";
                feed_s = "{% set c = feed.split(' ')[0].split(':') %}{{ (c[0] | int) * 60 + (c[1] | int) }}";
              };
            }
            { variables.feed_now_s = "{{ (feed_s - (as_timestamp(now()) - fetched)) | round(0) | int }}"; }
            { variables.raw = "{{ tv_s - feed_now_s }}"; }
            setDelay
            (calibrated "Bears delay calibrated" "TV {{ tv }}, ESPN {{ feed }} (now {{ feed_now_s }} s left): TV is {{ raw }} s behind, delay set to {{ states('${delay}') | int }} s.")
          ];
          "else" = [
            (calibrated "Bears delay not changed" "Needs a game in progress, a running clock and a TV clock like 7:42 (ESPN clock: {{ feed or 'none' }}).")
          ];
        }
      ];
    };

    bears_calibrate_from_score = {
      alias = "Bears calibrate delay from seen score";
      icon = "mdi:eye-check-outline";
      sequence = [
        { variables.scored_at = "{{ state_attr('input_datetime.bears_last_score', 'timestamp') }}"; }
        { variables.raw = "{{ (as_timestamp(now()) - (scored_at | float(0))) | round(0) | int }}"; }
        {
          "if" = "{{ scored_at is number and 0 <= raw <= state_attr('${delay}', 'max') | float(120) }}";
          "then" = [
            setDelay
            (calibrated "Bears delay calibrated" "The score reached Home Assistant {{ raw }} s before you saw it; delay set to {{ states('${delay}') | int }} s.")
          ];
          "else" = [
            (calibrated "Bears delay not changed" "No Bears score in the last {{ state_attr('${delay}', 'max') | int }} s.")
          ];
        }
      ];
    };
  };

  automation = [
    {
      id = "bears_score";
      alias = "Bears score";
      mode = "parallel";
      max = 10;
      triggers = [
        {
          trigger = "state";
          entity_id = "sensor.bears";
          attribute = "team_score";
        }
        {
          trigger = "state";
          entity_id = "sensor.bears";
          to = "PRE";
        }
      ];
      conditions = [
        "{{ trigger.to_state is not none and trigger.to_state.attributes.event_id is not none and (trigger.to_state.state == 'PRE' or trigger.to_state.state in ['IN', 'POST'] and trigger.to_state.attributes.team_score | int(-1) >= 0) }}"
      ];
      actions = [
        {
          variables = {
            score = "{{ trigger.to_state.attributes.team_score | int(0) }}";
            event = "{{ trigger.to_state.attributes.event_id | string }}";
          };
        }
        {
          variables.old = "{{ states('${mark}') | int(0) if trigger.to_state.state != 'PRE' and states('${eventId}') == event | string else score }}";
        }
        { variables.points = "{{ score - old }}"; }
        {
          action = "input_text.set_value";
          target.entity_id = eventId;
          data.value = "{{ event }}";
        }
        {
          action = "input_number.set_value";
          target.entity_id = mark;
          data.value = "{{ [score, old] | max }}";
        }
        {
          condition = "template";
          value_template = "{{ points > 0 }}";
        }
        {
          action = "input_datetime.set_datetime";
          target.entity_id = "input_datetime.bears_last_score";
          data.timestamp = "{{ as_timestamp(now()) }}";
        }
        gameModeOn
        { delay.seconds = "{{ states('${delay}') | int(0) }}"; }
        gameModeOn
        {
          condition = "template";
          value_template = "{{ state_attr('sensor.bears', 'team_score') | int(score) >= score }}";
        }
        celebrate
      ];
    }
    {
      id = "bears_poll";
      alias = "Bears poll during game mode";
      triggers = [
        {
          trigger = "time_pattern";
          seconds = "/20";
        }
      ];
      conditions = [
        gameModeOn
        {
          condition = "not";
          conditions = [
            {
              condition = "state";
              entity_id = "sensor.bears";
              state = [
                "IN"
                "POST"
              ];
            }
          ];
        }
      ];
      actions = [
        {
          action = "homeassistant.update_entity";
          target.entity_id = "sensor.bears";
        }
      ];
    }
  ];
}
