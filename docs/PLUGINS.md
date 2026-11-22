# Writing a Cutir plugin

A plugin is **one JSON file**. No code from the plugin runs on the page. Install it in **Settings > Plugins and system > Install from file**. Cutir lists what the plugin asks for, and nothing happens until you accept.

A starter file is in [plugin-starter/warm-tint.json](plugin-starter/warm-tint.json). The settings page can also save one for you.

## Manifest

```json
{
  "id": "warm-tint",
  "name": "Warm tint",
  "version": "1.0.0",
  "author": "You",
  "description": "What it does",
  "api": 1,
  "permissions": ["effects", "presets", "scripts"],
  "effects": [],
  "presets": [],
  "scripts": []
}
```

| Field | Rules |
| --- | --- |
| `id` | lowercase letters, digits, dashes; 2 to 41 characters; starts with a letter |
| `api` | must be `1` |
| `permissions` | `effects`, `presets`, `scripts`. Each kind of content needs its permission, or the file is refused |

A file that does not pass is refused with every problem listed in plain words.

## Effects

An effect is a **GLSL ES 3.00 fragment body** plus parameters. It runs on the graphics card inside the browser's WebGL sandbox. Without WebGL 2, or with "Use the graphics card for effects" turned off, the clip passes through unchanged.

```json
{
  "id": "tint",
  "name": "Tint",
  "category": "Colour",
  "description": "Mix a colour over the picture",
  "params": [
    { "key": "amount", "label": "Amount", "type": "number", "min": 0, "max": 100, "default": 40, "unit": "%" },
    { "key": "tone", "label": "Colour", "type": "color", "default": "#ff7a3d" }
  ],
  "glsl": "void main() { vec4 c = texture(uTex, vUv); outColor = vec4(mix(c.rgb, uCol_tone, u_amount / 100.0), c.a); }"
}
```

The effect appears in the inspector and the effects list as `<plugin id>-<effect id>`, with keyframes on every parameter, like a built-in one.

**Declared for you:** `in vec2 vUv` (0 to 1), `out vec4 outColor`, `uniform sampler2D uTex` (the clip), `uniform vec2 uSize` (pixels), `uniform float uTime` (seconds into the clip). Do not declare them yourself. `#extension` and `#include` are refused. Maximum 20,000 characters.

**Parameters become uniforms:**

| type | fields | uniform |
| --- | --- | --- |
| `number` | `min`, `max`, `default`, optional `step`, `unit` | `float u_<key>` |
| `angle` | `default` (degrees) | `float u_<key>` |
| `boolean` | `default` | `float u_<key>` (0 or 1) |
| `choice` | `options: [{value, label}]`, `default` | `float u_<key>` (index of the option) |
| `color` | `default` "#rrggbb" | `vec3 uCol_<key>` (0 to 1) |
| `point` | `default {x, y}` (0 to 1) | `vec2 uPt_<key>` |

Keys: a lowercase letter, then letters and digits, up to 24. Categories: Transform, Blur and sharpen, Colour, Stylize, Keying, Distort, Animation.

## Presets

Delivery presets in the same form as the Deliver page's preset export (`name`, `container`, `video`, `audio`, `width`, `height`, `fps`, `bitrateMbps`, `pattern` and so on). Invalid values are corrected the way an imported preset is. Removing the plugin removes its presets.

## Scripts

```json
{ "id": "count", "title": "Count clips", "code": "const clips = await cutir.clips();\nreturn clips.length + ' clips';" }
```

Each script becomes a command in the palette ("Plugin name: Count clips"). It runs in a sandboxed worker with the [scripting API](SCRIPTING.md).

## What a plugin cannot do

Run code on the page, read project files or media, or call the internals of the app. A script reaches the project only through the scripting API, which uses the same validated, undoable tools as the AI assistant. Script workers have the network APIs removed, but a script is still code: install only plugins you trust.

## Developing

Edit the JSON and install it again. The same `id` replaces the old copy. Shader errors are logged to the browser console and the effect falls back to passing the picture through.
