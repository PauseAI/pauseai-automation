import * as turf from '@turf/turf';
import { FeatureCollection, Point } from 'geojson';
import { agnes } from 'ml-hclust';

/**
 * Calculates the distance between two points in kilometers.
 *
 * @param a The coordinates of the first point as an array of [longitude, latitude].
 * @param b The coordinates of the second point as an array of [longitude, latitude].
 * @returns The distance between the two points in kilometers.
 */
function turfDistance(a: number[], b: number[]): number {
    const point1 = turf.point(a);
    const point2 = turf.point(b);
    // Returns distance in kilometers by default
    return turf.distance(point1, point2, { units: 'kilometers' });
}

/**
 * Clusters GeoJSON points using hierarchical clustering with a custom distance function.
 *
 * @param featureCollection The GeoJSON feature collection to cluster.
 * @param distanceLimit The maximum distance between any two points in a cluster, in kilometers.
 * @returns A new GeoJSON feature collection with an added `cluster` property for each point.
 * The `cluster` property is a number indicating the cluster that the point belongs to, or
 * undefined if the point does not belong to any cluster.
 */
function clusterGeoJSONPoints(
    featureCollection: FeatureCollection<Point>,
    distanceLimit: number = 1000 // default 1000 km limit
): FeatureCollection<Point, { cluster?: number }> {
    if (!featureCollection || !featureCollection.features || featureCollection.features.length === 0) {
        return turf.featureCollection([]);
    }

    const coordinates: number[][] = featureCollection.features.map(feature =>
        feature.geometry.coordinates
    );

    // Perform hierarchical clustering
    const clusters = agnes(coordinates, {
        method: 'complete',
        distanceFunction: turfDistance
    });

    // Cut the clusters at the specified distance limit
    const limitedClusters = clusters.cut(distanceLimit);

    // Map original features to their clusters
    const clusteredFeatures = featureCollection.features.map((feature, index) => {
        const newProperties = { ...feature.properties };
        for (let i = 0; i < limitedClusters.length; i++) {
            if (limitedClusters[i].indices().includes(index)) {
                newProperties.cluster = i;
                break;
            }
        }
        return turf.point(feature.geometry.coordinates, newProperties);
    });

    return turf.featureCollection(clusteredFeatures);
}

export default defineEventHandler(async (event) => {
    const headers = getHeaders(event);
    const apiKey = headers['x-clusters-api-key'];
    const expectedApiKey = requireEnv('CLUSTERS_API_KEY');

    if (!apiKey || apiKey !== expectedApiKey) {
        throw createError({
            statusCode: 401,
            statusMessage: 'Unauthorized'
        });
    }

    const [ featureCollection, distanceLimit ] = await readBody(event);
    return clusterGeoJSONPoints(featureCollection, distanceLimit);
});
