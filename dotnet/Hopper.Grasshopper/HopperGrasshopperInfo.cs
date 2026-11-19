using System;
using System.Drawing;
using Grasshopper;
using Grasshopper.Kernel;
using Hopper.Core;

namespace rhino_zmq_poc
{
  public class rhino_zmq_pocInfo : GH_AssemblyInfo
  {
    public override string Name => "HopperCode";

    //Return a 24x24 pixel bitmap to represent this GHA library.
    public override Bitmap Icon => PluginIcon.Bitmap;

    //Return a short string describing the purpose of this GHA library.
    public override string Description => "Lazy Grasshopper operations for the Rhino-owned Hopper host";

    public override Guid Id => new Guid(PublicIdentity.GrasshopperAssemblyId);

    //Return a string identifying you or your company.
    public override string AuthorName => "aectooling by tomoS";

    //Return a string representing your preferred contact details.
    public override string AuthorContact => "";

    //Return a string representing the version.  This returns the same version as the assembly.
    public override string AssemblyVersion => GetType().Assembly.GetName().Version.ToString();
  }
}
