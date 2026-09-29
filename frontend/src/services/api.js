import axios from "axios";

const queryBackend = async (relativePath) => {
  return axios.get(`/api/${relativePath}`, { responseType: "text", transformResponse: (data) => data });
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
