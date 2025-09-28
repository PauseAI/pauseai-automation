# pauseai-automation

[![Netlify Status](https://api.netlify.com/api/v1/badges/290ed007-d791-4047-b486-ad6a3f7e818d/deploy-status)](https://app.netlify.com/projects/pauseai-automation/deploys)

This repository contains API endpoints that support various automations. This includes a Stripe webhook endpoint for updating the payment status of paying members in Airtable, and a geographical point clustering endpoint designed to be called from an automation.

## Endpoints

- `POST /stripe`: Handles Stripe webhook events.
  - **Request Body:** Stripe webhook event object.
  - **Returns:** JSON object indicating status.
- `POST /clusters`: Performs geographical point clustering. Requires authentication using `CLUSTERS_API_KEY` in an `X-Clusters-API-Key` header.
  - **Request Body:** `[FeatureCollection<Point>, number]` (GeoJSON FeatureCollection of points and a distance limit in kilometers).
  - **Returns:** `FeatureCollection<Point, { cluster?: number }>` (GeoJSON FeatureCollection with an added optional `cluster` property within the `properties` object for each point).

## Environment Variables

- `CLUSTERS_API_KEY`: Required for authenticating requests to the `/clusters` endpoint.
