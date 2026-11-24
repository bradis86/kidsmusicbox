# Optional Home Assistant integration

Everyday hub playback, schedules and screen blanking work without Home Assistant.

For real playback use the [official Music Assistant integration](https://www.home-assistant.io/integrations/music_assistant/). It exposes MA players as media-player entities with controls and metadata. Select the actual entity in HA's automation UI; do not assume an entity ID. HA can control the same player independently, so the hub's volume limit applies to hub requests, not every controller.

## Stop the assigned player at bedtime

Create an automation in HA's UI with a time trigger and a **Media player: Stop** action targeting your selected MA entity. HA then owns that automation. The hub can also enforce its own bedtime restriction; choose matching timezones and times. The hub's own restriction blocks playback requests, while HA-only stopping does not prevent a later restart from another controller.

## Screen control from HA

The hub provides a separate, screen-only bearer endpoint. Set a long random `AUTOMATION_TOKEN` in its environment, then store the full authorization header in HA's `secrets.yaml`. This is not an MA token and does not grant parent administration or music-library permissions.

The following is an optional **HA package** example. Replace the hub URL in `secrets.yaml` with its LAN endpoint. Nothing in this example is automatically applied to your Home Assistant instance.

```yaml
# secrets.yaml (example values only)
kids_music_screen_url: 'http://YOUR_DOCKER_HOST:3210/api/automation/screen'
kids_music_screen_auth: 'Bearer REPLACE_WITH_THE_HUB_AUTOMATION_TOKEN'
```

```yaml
# packages/kids_music_hub.yaml
rest_command:
  kids_music_screen:
    url: !secret kids_music_screen_url
    method: POST
    headers:
      authorization: !secret kids_music_screen_auth
    content_type: 'application/json'
    payload: '{"mode": "{{ mode }}"}'
    timeout: 10

automation:
  - alias: Kids music - dark bedroom
    id: kids_music_dark_bedroom
    triggers:
      - trigger: time
        at: '19:30:00'
    actions:
      - action: rest_command.kids_music_screen
        data:
          mode: 'off'
    mode: single
  - alias: Kids music - restore morning screen schedule
    id: kids_music_morning_screen
    triggers:
      - trigger: time
        at: '07:00:00'
    actions:
      - action: rest_command.kids_music_screen
        data:
          mode: 'auto'
    mode: single
```

HA's timezone controls its triggers; the hub's timezone controls the hub schedule. `off` and `on` are persistent manual overrides. `auto` returns control to the configured hub schedule. If HA is down, the last override stays active, so the hub's built-in schedule alone is preferable when no external automation is needed.

Screen policy and last browser acknowledgement are visible in Parent Device & diagnostics. Playback metadata and availability come from the official MA media player entities; this app does not create duplicate HA entities. API acknowledgements describe requested browser blanking, not proof of physical backlight power-off.

The [RESTful command documentation](https://www.home-assistant.io/integrations/rest_command/) and [time trigger documentation](https://www.home-assistant.io/docs/automation/trigger/#time-trigger) describe the configuration used above. Validate the optional package in your HA installation before enabling it.
