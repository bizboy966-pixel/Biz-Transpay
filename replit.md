# Biz-transPay on Replit

## Run configuration

The `Start application` workflow starts the existing stack without restructuring
the project:

- MongoDB uses the local `.data/mongodb` directory on port `27017`.
- FastAPI serves the backend on port `8000`.
- React/CRACO serves the frontend preview on port `5000`.
- The frontend proxy forwards `/api` requests to the backend.

The local development database is intended for Replit Preview and development.
For a shared or persistent environment, configure an external MongoDB connection
and set `MONGO_URL` and `DB_NAME` in Replit environment settings.

## Optional payment configuration

Stripe, FedaPay, and IziChangePay credentials are only needed for their
corresponding live payment flows. Keep those values in Replit Secrets; do not
place them in source files or frontend environment variables.