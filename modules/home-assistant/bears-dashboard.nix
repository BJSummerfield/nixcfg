{
  title = "Bears";
  views = [
    {
      title = "Game";
      path = "game";
      icon = "mdi:football";
      cards = [
        {
          type = "entities";
          title = "Bears";
          entities = [
            "input_boolean.bears_game_mode"
            "input_number.bears_tv_delay"
            {
              entity = "sensor.bears";
              secondary_info = "last-updated";
            }
            {
              type = "attribute";
              entity = "sensor.bears";
              attribute = "clock";
              name = "ESPN clock";
            }
            {
              type = "attribute";
              entity = "sensor.bears";
              attribute = "team_score";
              name = "Bears score";
            }
            "input_text.bears_tv_clock"
            "script.bears_calibrate_from_clock"
            "script.bears_calibrate_from_score"
            "script.bears_test_celebration"
            "input_datetime.bears_last_score"
          ];
        }
      ];
    }
  ];
}
