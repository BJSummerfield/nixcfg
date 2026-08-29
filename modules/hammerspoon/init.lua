PaperWM = hs.loadSpoon("PaperWM")
PaperWM:bindHotkeys({
    focus_left  = {"alt", "left"},
    focus_right = {"alt", "right"},
    focus_up    = {"alt", "up"},
    focus_down  = {"alt", "down"},

    -- focus_prev = {{"alt", "cmd"}, "k"},
    -- focus_next = {{"alt", "cmd"}, "j"},

    swap_left  = {{"alt", "shift"}, "left"},
    swap_right = {{"alt", "shift"}, "right"},
    -- swap_up    = {{"alt", "cmd", "shift"}, "up"},
    -- swap_down  = {{"alt", "cmd", "shift"}, "down"},

    -- alternative: swap entire columns instead of windows
    -- swap_column_left = {{"alt", "cmd", "shift"}, "left"},
    -- swap_column_right = {{"alt", "cmd", "shift"}, "right"},

    center_window        = {"alt", "c"},
    full_width           = {"alt", "f"},
    cycle_width          = {"alt", "r"},
    reverse_cycle_width  = {{"shift", "alt"}, "r"},
    -- cycle_height         = {{"alt", "cmd", "shift"}, "r"},
    -- reverse_cycle_height = {{"ctrl", "alt", "cmd", "shift"}, "r"},

    increase_width = {"alt", "l"},
    decrease_width = {"alt", "h"},

    -- move focused window into / out of a column
    slurp_in = {{"alt", "cmd"}, "i"},
    barf_out = {{"alt", "cmd"}, "o"},

    toggle_floating = {{"alt", "cmd", "shift"}, "escape"},

    -- focus_window_1 = {{"cmd", "shift"}, "1"},
    -- focus_window_2 = {{"cmd", "shift"}, "2"},
    -- focus_window_3 = {{"cmd", "shift"}, "3"},
    -- focus_window_4 = {{"cmd", "shift"}, "4"},
    -- focus_window_5 = {{"cmd", "shift"}, "5"},
    -- focus_window_6 = {{"cmd", "shift"}, "6"},
    -- focus_window_7 = {{"cmd", "shift"}, "7"},
    -- focus_window_8 = {{"cmd", "shift"}, "8"},
    -- focus_window_9 = {{"cmd", "shift"}, "9"},

    switch_space_1 = {"alt", "1"},
    switch_space_2 = {"alt", "2"},
    switch_space_3 = {"alt", "3"},
    switch_space_4 = {"alt", "4"},
    switch_space_5 = {"alt", "5"},
    switch_space_6 = {"alt", "6"},
    switch_space_7 = {"alt", "7"},
    switch_space_8 = {"alt", "8"},
    switch_space_9 = {"alt", "9"},

    move_window_1 = {{"alt", "shift"}, "1"},
    move_window_2 = {{"alt", "shift"}, "2"},
    move_window_3 = {{"alt", "shift"}, "3"},
    move_window_4 = {{"alt", "shift"}, "4"},
    move_window_5 = {{"alt", "shift"}, "5"},
    move_window_6 = {{"alt", "shift"}, "6"},
    move_window_7 = {{"alt", "shift"}, "7"},
    move_window_8 = {{"alt", "shift"}, "8"},
    move_window_9 = {{"alt", "shift"}, "9"}
})
PaperWM:start()
