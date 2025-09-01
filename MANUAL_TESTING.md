# Manual testing

## Uploading CSV populates `playersCache`

1. Start the server:
   ```bash
   npm start
   ```
2. Open <http://localhost:3000> in a browser.
3. Use the "Seleziona CSV" control to pick `Lista-FantaAsta-Fantacalcio.csv`.
4. After the file is processed a success message appears. Open the browser console and run:
   ```js
   playersCache[0]
   ```
5. Confirm that the returned object contains Italian keys (`Nome`, `Ruolo`, `Squadra`, `Immagine`).

This verifies that uploading a CSV produces correctly normalised player entries in `playersCache`.
