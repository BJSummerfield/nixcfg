let
  delay = "input_number.bears_tv_delay";
  notify = title: message: {
    action = "persistent_notification.create";
    data = {
      notification_id = "bears_touchdown";
      inherit title message;
    };
  };
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
  celebrate = points: extra: {
    action = "script.turn_on";
    target.entity_id = "script.bears_celebrate";
    data.variables = {
      inherit points;
    }
    // extra;
  };
  testScore = alias: points: {
    inherit alias;
    icon = "mdi:football";
    sequence = [ (celebrate points { report_missing = true; }) ];
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

  input_text.bears_tv_clock = {
    name = "Bears TV clock";
    icon = "mdi:clock-digital";
    max = 5;
    pattern = "[0-9]{1,2}:[0-9]{2}";
  };

  input_datetime.bears_last_score = {
    name = "Bears last score";
    has_date = true;
    has_time = true;
  };

  script = {
    bears_celebrate = {
      alias = "Bears celebrate";
      icon = "mdi:party-popper";
      mode = "queued";
      max = 10;
      fields = {
        points = {
          name = "Points";
          required = true;
          selector.number = {
            min = 1;
            max = 8;
          };
        };
        report_missing = {
          name = "Report a missing show";
          default = false;
        };
      };
      sequence = [
        {
          variables.show = "{% set p = points | int(0) %}{{ 'bears_touchdown' if p >= 6 else 'bears_field_goal' if p >= 3 else 'bears_two_points' if p == 2 else 'bears_extra_point' if p == 1 else \"\" }}";
        }
        {
          "if" = "{{ show != \"\" and has_value('script.' ~ show) }}";
          "then" = [ { action = "script.{{ show }}"; } ];
          "else" = [
            {
              "if" = "{{ show != \"\" and report_missing | default(false) }}";
              "then" = [
                (notify "No Bears show" "Create script.{{ show }} in Settings > Automations & scenes > Scripts.")
              ];
            }
          ];
        }
      ];
    };

    bears_test_touchdown = testScore "Bears test touchdown" 7;
    bears_test_field_goal = testScore "Bears test field goal" 3;
    bears_test_two_points = testScore "Bears test two points" 2;
    bears_test_extra_point = testScore "Bears test extra point" 1;

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
            "{{ is_state('sensor.bears', 'IN') and tv is match('[0-9]{1,2}:[0-9]{2}$') and feed is match('[0-9]{1,2}:[0-9]{2} ') and fetched is not none }}";
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
            (notify "Bears delay calibrated" "TV {{ tv }}, ESPN {{ feed }} (now {{ feed_now_s }} s left): TV is {{ raw }} s behind, delay set to {{ states('${delay}') | int }} s.")
          ];
          "else" = [
            (notify "Bears delay not changed" "Needs a game in progress, a running clock and a TV clock like 7:42 (ESPN clock: {{ feed or 'none' }}).")
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
            (notify "Bears delay calibrated" "The score reached Home Assistant {{ raw }} s before you saw it; delay set to {{ states('${delay}') | int }} s.")
          ];
          "else" = [
            (notify "Bears delay not changed" "No Bears score in the last {{ state_attr('${delay}', 'max') | int }} s.")
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
      ];
      variables.points = "{% if trigger.from_state and trigger.to_state %}{{ trigger.to_state.attributes.team_score | int(-1) - trigger.from_state.attributes.team_score | int(-1) }}{% else %}0{% endif %}";
      conditions = [
        "{{ trigger.from_state is not none and trigger.to_state is not none and trigger.from_state.state == 'IN' and trigger.to_state.state in ['IN', 'POST'] }}"
        "{{ trigger.from_state.attributes.team_score | int(-1) >= 0 and points > 0 }}"
      ];
      actions = [
        {
          action = "input_datetime.set_datetime";
          target.entity_id = "input_datetime.bears_last_score";
          data.timestamp = "{{ as_timestamp(now()) }}";
        }
        gameModeOn
        { delay.seconds = "{{ states('${delay}') | int(0) }}"; }
        gameModeOn
        (celebrate "{{ points }}" { })
      ];
    }
  ];
}
