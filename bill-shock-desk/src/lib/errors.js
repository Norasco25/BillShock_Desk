/** An error that carries an HTTP status. The server turns it into a JSON response. */
export class HttpError extends Error {
  /**
   * @param {number} status
   * @param {string} message  safe to show to the caller
   * @param {object} [details] extra fields merged into the JSON body; `headers` is sent as HTTP headers
   */
  constructor(status, message, details = {}) {
    super(message);
    this.status = status;
    this.details = details;
  }
}
