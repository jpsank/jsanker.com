import axios from "axios";

const host = process.env.hasOwnProperty('DEPLOY_URL') ? process.env.DEPLOY_URL : '';
const serverQuery = async (path) => {
  // a simple wrapper for making fetch GET requests
  // no need to supply the whole URL, only the relative path
  return axios.post(`${host}/.netlify/functions/serverQuery`, { path: path });
};

const backendURL = process.env.NODE_ENV === "development" ? "http://127.0.0.1:5000" : "https://api.jsanker.com";
const queryBackend = async (relativePath) => {
  return serverQuery(`${backendURL}/${relativePath}`);
};


// Main API functions
export const fetchResponseFromAPI = async (endpoint, params = null) => {
  return queryBackend(params === null ? endpoint : (endpoint + "?" + new URLSearchParams(params)));
};

export const fetchFromAPI = async (endpoint, params = null) => {
  return fetchResponseFromAPI(endpoint, params).then((response) => {
    return response.data;
  });
};

// Game of Life API functions
export const fetchGOLPattern = async (id = null) => {
  return fetchFromAPI("pattern", id === null ? null : { id });
};
