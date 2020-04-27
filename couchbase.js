import couchbase from 'couchbase';

function uniqueNames(names) {
    if (names.length > 1) {
        return names.filter((bucketName, index) => names.indexOf(bucketName) === index);
    }
    return names;
}

export default class CouchBaseAdapter {
    constructor(host, port, userName, password, bucketNames = []) {
        const connectionString = `${host}:${port}`;
        this.cluster = new couchbase.Cluster(connectionString);
        this.cluster.authenticate(userName, password);
        this.buckets = {};
        const uniqueBucketNames = uniqueNames(bucketNames);
        if (uniqueBucketNames.length === 0) {
            const ex = new Error('CouchBaseAdapter Failed to initialize:: No buckets specified');
            throw ex;
        }
        uniqueBucketNames.map(bucketName => {
            this.buckets[bucketName] = this.cluster.openBucket(bucketName, err => {
                if (err) {
                    throw err;
                }
            });
        });
    }


	/**
	 * @param {string} bucketName The bucket name to run the query on
	 * @param {string} query The N1QL query with variable params such as $1
	 * @param {array<any>} params The params to be replaced in the N1QL query
	 */
    query(bucketName, query, params = []) {
        return new Promise((resolve, reject) => {
            if (!query) {
                return reject({ message: 'Invalid Query' })
            }
            this.buckets[bucketName].query(
                couchbase.N1qlQuery.fromString(query, params),
                function (err, result) {
                    if (err) {
                        return reject(err);
                    }
                    return resolve(result);
                }
            );
        })
    }

}