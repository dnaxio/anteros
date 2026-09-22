// Test fixture — throws while being imported: the loader must isolate the
// failure and keep loading the other workflows of the tenant.
throw new Error("boom — broken workflow fixture");
