# Deployment

1. Copiare `.env.example` in `.env` e impostare i valori desiderati per `HOST_PIN` e `INVITE_SECRET`.
2. Avviare l'applicazione fornendo queste variabili d'ambiente.
   - **Node.js**: `HOST_PIN=1234 INVITE_SECRET=segreto npm start`
   - **Docker**:
     ```bash
     docker build -t auction-app .
     docker run --name auction --rm -p 3000:3000 --env-file .env auction-app
     ```

## Note

- Alla lettura dei partecipanti il sistema elimina eventuali duplicati basati su `id`,
  mantenendo l'ultimo record valido e loggando gli identificativi rimossi.
