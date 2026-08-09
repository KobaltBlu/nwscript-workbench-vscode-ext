# Publishing

## Package locally

```bash
npm install
npm run package:list
npm run package
```

Install the generated `.vsix` into clean VS Code and Cursor profiles before publishing.

## Visual Studio Marketplace

Create the `KobaltBlu` publisher and configure a Marketplace publishing token, then run:

```bash
npm run publish:vscode
```

## Open VSX

Create or claim the `KobaltBlu` namespace on Open VSX, create an access token, then run:

```bash
npx ovsx create-namespace KobaltBlu -p <token>
npm run publish:openvsx -- -p <token>
```

The permanent extension identifier is:

```text
KobaltBlu.nwscript
```

Do not change `publisher` or `name` after the first public release unless intentionally creating a new marketplace listing.